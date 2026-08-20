# Website

Astro static site. Content and branding come from `src/data/brand.json`,
which is a copy of the project-root `brand.json` (run `scripts/sync.sh` to refresh).

    npm install     # once
    npm run dev     # preview at http://localhost:4321
    npm run build   # emits dist/ — this is what gets deployed

Deploy: connect the repo to Cloudflare Pages.
Build command `npm run build`, output directory `dist`.
