const games = [
    { id: 'snake', name: 'Snake', category: 'arcade', emoji: '🐍', gradient: 'var(--gradient-5)', file: 'games/snake.html' },
    { id: 'tetris', name: 'Tetris', category: 'puzzle', emoji: '🧱', gradient: 'var(--gradient-1)', file: 'games/tetris.html' },
    { id: '2048', name: '2048', category: 'puzzle', emoji: '🔢', gradient: 'var(--gradient-4)', file: 'games/2048.html' },
    { id: 'flappy', name: 'Flappy Bird', category: 'arcade', emoji: '🐦', gradient: 'var(--gradient-2)', file: 'games/flappy.html' },
    { id: 'minesweeper', name: 'Minesweeper', category: 'strategy', emoji: '💣', gradient: 'var(--gradient-7)', file: 'games/minesweeper.html' },
    { id: 'memory', name: 'Memory Match', category: 'casual', emoji: '🃏', gradient: 'var(--gradient-3)', file: 'games/memory.html' },
    { id: 'breakout', name: 'Breakout', category: 'arcade', emoji: '🧱', gradient: 'var(--gradient-6)', file: 'games/breakout.html' },
    { id: 'tictactoe', name: 'Tic Tac Toe', category: 'strategy', emoji: '⭕', gradient: 'var(--gradient-8)', file: 'games/tictactoe.html' },
    { id: 'whackamole', name: 'Whack-a-Mole', category: 'casual', emoji: '🔨', gradient: 'var(--gradient-5)', file: 'games/whackamole.html' },
    { id: 'pong', name: 'Pong', category: 'arcade', emoji: '🏓', gradient: 'var(--gradient-1)', file: 'games/pong.html' },
    { id: 'sudoku', name: 'Sudoku', category: 'puzzle', emoji: '9️⃣', gradient: 'var(--gradient-2)', file: 'games/sudoku.html' },
    { id: 'dino', name: 'Dino Run', category: 'arcade', emoji: '🦕', gradient: 'var(--gradient-4)', file: 'games/dino.html' },
];

const grid = document.getElementById('gamesGrid');
const modal = document.getElementById('gameModal');
const modalTitle = document.getElementById('gameModalTitle');
const modalClose = document.getElementById('modalClose');
const gameFrame = document.getElementById('gameFrame');

let currentCategory = 'all';

function renderGames(category) {
    const filtered = category === 'all' ? games : games.filter(g => g.category === category);
    grid.innerHTML = filtered.map(game => `
        <div class="game-card" data-game="${game.id}" onclick="openGame('${game.id}')">
            <div class="game-card-thumb" style="background: ${game.gradient}">
                ${game.emoji}
            </div>
            <div class="game-card-info">
                <h3>${game.name}</h3>
                <span class="game-category">${game.category}</span>
            </div>
        </div>
    `).join('');
}

function openGame(id) {
    const game = games.find(g => g.id === id);
    if (!game) return;
    modalTitle.textContent = game.name;
    gameFrame.src = game.file;
    modal.classList.add('active');
    document.body.style.overflow = 'hidden';
}

function closeModal() {
    modal.classList.remove('active');
    gameFrame.src = '';
    document.body.style.overflow = '';
}

modalClose.addEventListener('click', closeModal);
modal.addEventListener('click', (e) => {
    if (e.target === modal) closeModal();
});
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeModal();
});

document.querySelectorAll('.nav-link').forEach(link => {
    link.addEventListener('click', (e) => {
        e.preventDefault();
        document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));
        link.classList.add('active');
        currentCategory = link.dataset.category;
        renderGames(currentCategory);
    });
});

renderGames('all');
