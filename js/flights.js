/* =========================================================================
 * SkyCalm - Flight picker with a per-departure turbulence forecast.
 *
 * The forecast is a deterministic physical-ish model: given the same route,
 * date and departure time it always produces the same result. It blends the
 * main real-world drivers of turbulence so the numbers move in believable
 * ways rather than being pure noise:
 *
 *   1. Time of day   - daytime surface heating drives convective ("thermal")
 *                      turbulence that peaks in the afternoon and fades at
 *                      night.
 *   2. Latitude      - mid-latitude routes (~30-60 deg) sit under the jet
 *                      stream where clear-air turbulence (CAT) is common.
 *   3. Season        - winter jet streams are stronger -> more CAT.
 *   4. Route length  - longer flights cross more weather systems and spend
 *                      more time near jet cores.
 *   5. Weather noise - a deterministic per-flight perturbation standing in
 *                      for the day's synoptic weather.
 * ========================================================================= */

const AIRPORTS = [
    { code: 'SFO', city: 'San Francisco', lat: 37.62, lon: -122.38 },
    { code: 'LAX', city: 'Los Angeles', lat: 33.94, lon: -118.41 },
    { code: 'JFK', city: 'New York', lat: 40.64, lon: -73.78 },
    { code: 'ORD', city: 'Chicago', lat: 41.98, lon: -87.90 },
    { code: 'DEN', city: 'Denver', lat: 39.86, lon: -104.67 },
    { code: 'SEA', city: 'Seattle', lat: 47.45, lon: -122.31 },
    { code: 'MIA', city: 'Miami', lat: 25.80, lon: -80.29 },
    { code: 'BOS', city: 'Boston', lat: 42.36, lon: -71.01 },
    { code: 'LHR', city: 'London', lat: 51.47, lon: -0.46 },
    { code: 'CDG', city: 'Paris', lat: 49.01, lon: 2.55 },
    { code: 'FRA', city: 'Frankfurt', lat: 50.04, lon: 8.56 },
    { code: 'DXB', city: 'Dubai', lat: 25.25, lon: 55.36 },
    { code: 'HND', city: 'Tokyo', lat: 35.55, lon: 139.78 },
    { code: 'SIN', city: 'Singapore', lat: 1.36, lon: 103.99 },
    { code: 'SYD', city: 'Sydney', lat: -33.95, lon: 151.18 },
    { code: 'HKG', city: 'Hong Kong', lat: 22.31, lon: 113.91 },
    { code: 'PEK', city: 'Beijing', lat: 40.08, lon: 116.58 },
    { code: 'GRU', city: 'Sao Paulo', lat: -23.43, lon: -46.47 }
];

const AIRLINES = [
    { name: 'Aether Air', prefix: 'AE' },
    { name: 'Zephyr Lines', prefix: 'ZP' },
    { name: 'Cirrus Airways', prefix: 'CR' },
    { name: 'Nimbus Jet', prefix: 'NB' },
    { name: 'Meridian Air', prefix: 'MD' },
    { name: 'Skylark', prefix: 'SK' }
];

// Departure slots spread across the day (24h hours).
const DEPARTURE_HOURS = [6, 8, 10, 12, 14, 16, 18, 20, 22];

const TURB_LEVELS = [
    { max: 25,  name: 'Smooth',   cls: 'level-smooth',   note: 'Calm air expected. Drinks service should be uninterrupted.' },
    { max: 50,  name: 'Light',    cls: 'level-light',    note: 'Occasional light bumps. Keep your seatbelt loosely fastened.' },
    { max: 75,  name: 'Moderate', cls: 'level-moderate', note: 'Noticeable bumps likely. Seatbelt sign may stay on for stretches.' },
    { max: 101, name: 'Severe',   cls: 'level-severe',   note: 'Rough patches probable. Expect the seatbelt sign on for much of the flight.' }
];

/* ---------- deterministic helpers ---------- */

// Hash a string to a 32-bit integer (FNV-1a style).
function hashString(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
}

// Seeded PRNG (mulberry32) -> returns a function giving floats in [0, 1).
function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0;
        a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// Great-circle distance in km.
function haversine(a, b) {
    const R = 6371;
    const toRad = d => (d * Math.PI) / 180;
    const dLat = toRad(b.lat - a.lat);
    const dLon = toRad(b.lon - a.lon);
    const lat1 = toRad(a.lat);
    const lat2 = toRad(b.lat);
    const h = Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/* ---------- the turbulence model ---------- */

// How much daytime convective turbulence at a given local hour (0..1).
// Peaks ~16:00 (max surface heating), near zero overnight.
function thermalFactor(hour) {
    const peak = 16;
    const spread = 6;
    const v = Math.exp(-((hour - peak) ** 2) / (2 * spread * spread));
    return v; // 0..1
}

// Jet-stream / clear-air turbulence exposure from latitude band (0..1).
function jetStreamFactor(lat) {
    const a = Math.abs(lat);
    // Bell centred on ~45 deg, the core of the mid-latitude jet.
    return Math.exp(-((a - 45) ** 2) / (2 * 15 * 15));
}

// Seasonal multiplier: stronger jets / storms in the hemisphere's winter.
function seasonFactor(month, lat) {
    // month: 0..11. Northern winter ~ Dec-Feb; flip for southern hemisphere.
    const phase = lat >= 0 ? 0 : 6;
    const m = (month + phase) % 12;
    // Cosine peaking in deep winter (m=0 -> January).
    return 0.85 + 0.3 * Math.cos((m / 12) * 2 * Math.PI);
}

// Compute a 0..100 turbulence index plus the dominant contributing factor.
function predictTurbulence(origin, dest, dateStr, hour, distanceKm) {
    const rng = mulberry32(hashString(`${origin.code}|${dest.code}|${dateStr}|${hour}`));
    const month = new Date(dateStr + 'T00:00:00').getMonth();
    const midLat = (origin.lat + dest.lat) / 2;

    const thermal = thermalFactor(hour);                          // 0..1
    const jet = jetStreamFactor(midLat) * seasonFactor(month, midLat); // ~0..1.15
    const route = Math.min(1, distanceKm / 9000);                 // 0..1
    const weather = rng();                                        // 0..1

    // Weighted blend -> 0..100. Weights chosen so a hot afternoon under a
    // winter jet on a long route can reach "Severe", while a calm dawn
    // short-hop near the equator stays "Smooth".
    let score =
        thermal * 34 +
        jet * 30 +
        route * 14 +
        weather * 22;

    score = Math.max(2, Math.min(99, Math.round(score)));

    // Identify the biggest driver for the note shown to the user.
    const drivers = [
        { k: 'thermal', v: thermal * 34, txt: 'afternoon thermal activity' },
        { k: 'jet', v: jet * 30, txt: 'jet-stream / clear-air turbulence' },
        { k: 'route', v: route * 14, txt: 'a long over-system route' },
        { k: 'weather', v: weather * 22, txt: 'the day’s weather pattern' }
    ].sort((a, b) => b.v - a.v);

    return { score, topDriver: drivers[0].txt };
}

function levelFor(score) {
    return TURB_LEVELS.find(l => score < l.max);
}

/* ---------- flight generation ---------- */

function buildFlights(origin, dest, dateStr) {
    const distanceKm = haversine(origin, dest);
    const cruiseKmh = 820;
    const durationH = distanceKm / cruiseKmh + 0.6; // + taxi/climb/descent

    const rng = mulberry32(hashString(`${origin.code}${dest.code}${dateStr}`));

    return DEPARTURE_HOURS.map((hour, i) => {
        const airline = AIRLINES[Math.floor(rng() * AIRLINES.length)];
        const flightNo = airline.prefix + (100 + Math.floor(rng() * 8900));
        const depMin = hour * 60 + Math.floor(rng() * 4) * 15; // 0/15/30/45
        const arrMin = depMin + Math.round(durationH * 60);
        const turb = predictTurbulence(origin, dest, dateStr, hour, distanceKm);
        const level = levelFor(turb.score);
        return {
            airline: airline.name,
            flightNo,
            depMin,
            arrMin,
            durationH,
            score: turb.score,
            topDriver: turb.topDriver,
            level
        };
    });
}

/* ---------- rendering ---------- */

function fmtTime(totalMin) {
    const dayOffset = Math.floor(totalMin / 1440);
    const m = ((totalMin % 1440) + 1440) % 1440;
    const hh = String(Math.floor(m / 60)).padStart(2, '0');
    const mm = String(m % 60).padStart(2, '0');
    return `${hh}:${mm}${dayOffset > 0 ? ' +' + dayOffset : ''}`;
}

function fmtDuration(h) {
    const total = Math.round(h * 60);
    return `${Math.floor(total / 60)}h ${total % 60}m`;
}

function render(origin, dest, dateStr) {
    const results = document.getElementById('results');

    if (origin.code === dest.code) {
        results.innerHTML = `<div class="empty-state"><span class="emoji">\u{1F503}</span>Origin and destination must be different.</div>`;
        return;
    }

    const flights = buildFlights(origin, dest, dateStr);
    const bestScore = Math.min(...flights.map(f => f.score));

    let html = `<p class="results-summary"><strong>${flights.length}</strong> flights ${origin.city} (${origin.code}) → ${dest.city} (${dest.code}) on ${dateStr}, ranked by departure time. Lowest turbulence flagged below.</p>`;

    html += flights.map(f => {
        const isBest = f.score === bestScore;
        return `
        <article class="flight-card ${f.level.cls} ${isBest ? 'best' : ''}">
            <div class="flight-airline">
                <span class="name">${f.airline}</span>
                <span class="number">${f.flightNo}</span>
                ${isBest ? '<span class="best-tag">✨ Smoothest pick</span>' : ''}
            </div>
            <div class="flight-schedule">
                <div class="time">
                    <div class="clock">${fmtTime(f.depMin)}</div>
                    <div class="code">${origin.code}</div>
                </div>
                <div class="flight-path">
                    <div class="duration">${fmtDuration(f.durationH)}</div>
                    <div class="line"></div>
                    <div class="duration">nonstop</div>
                </div>
                <div class="time">
                    <div class="clock">${fmtTime(f.arrMin)}</div>
                    <div class="code">${dest.code}</div>
                </div>
            </div>
            <div class="turb">
                <div class="turb-header">
                    <span class="turb-label">${f.level.name}</span>
                    <span class="turb-score">${f.score}/100</span>
                </div>
                <div class="turb-bar"><div class="turb-bar-fill" style="width:${f.score}%"></div></div>
                <div class="turb-note">${f.level.note} Main driver: ${f.topDriver}.</div>
            </div>
        </article>`;
    }).join('');

    results.innerHTML = html;
}

/* ---------- init ---------- */

function populateSelect(sel, defaultCode) {
    sel.innerHTML = AIRPORTS
        .map(a => `<option value="${a.code}">${a.city} (${a.code})</option>`)
        .join('');
    sel.value = defaultCode;
}

function airportByCode(code) {
    return AIRPORTS.find(a => a.code === code);
}

document.addEventListener('DOMContentLoaded', () => {
    const originSel = document.getElementById('origin');
    const destSel = document.getElementById('destination');
    const dateInput = document.getElementById('date');
    const form = document.getElementById('searchForm');
    const swapBtn = document.getElementById('swapBtn');

    populateSelect(originSel, 'SFO');
    populateSelect(destSel, 'JFK');

    // Default date = today.
    const today = new Date();
    const iso = today.toISOString().slice(0, 10);
    dateInput.value = iso;
    dateInput.min = iso;

    swapBtn.addEventListener('click', () => {
        const a = originSel.value;
        originSel.value = destSel.value;
        destSel.value = a;
    });

    form.addEventListener('submit', e => {
        e.preventDefault();
        render(airportByCode(originSel.value), airportByCode(destSel.value), dateInput.value);
    });

    // Show an initial result so the page isn't empty on load.
    render(airportByCode(originSel.value), airportByCode(destSel.value), dateInput.value);
});
