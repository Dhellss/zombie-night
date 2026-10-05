# Zombie Night

**Play it:** https://dhellss.github.io/zombie-night/

A small top-down zombie survival game. Plain HTML, CSS and JavaScript on a canvas, with no build step and no dependencies.

## Play

Open `index.html` in a browser. That's it.

| Key | Action |
| --- | --- |
| WASD / arrows | Move |
| Mouse | Aim |
| Left click (hold) | Shoot |
| R | Reload |
| Esc | Pause |

On touch screens, the left half of the screen moves and the right half aims and fires.

## Put it on GitHub Pages

1. Upload `index.html`, `style.css`, `game.js` and the `assets/` folder to a repository.
2. In the repository, go to **Settings → Pages**, set **Source** to *Deploy from a branch*, pick your branch and the `/ (root)` folder, and save.
3. Open `https://USERNAME.github.io/REPOSITORY/` once the deploy finishes.

All paths are relative, so the game works from a repository subpath as well as from a local file.

## Files

- `index.html` – the page, HUD and menu screens
- `style.css` – screen and HUD styling
- `game.js` – everything else: game loop, player, zombies, bullets, waves, upgrades, audio (Web Audio, no sound files), UI and saving
- `assets/icon.svg` – favicon

Best wave and settings are saved in `localStorage`.
