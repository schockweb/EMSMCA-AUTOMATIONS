import { defineConfig } from 'astro/config';
import brand from './src/data/brand.json';

export default defineConfig({
  // Used to build absolute URLs in the sitemap, Open Graph tags and vCard links.
  site: brand.client.url,
  // 'static' emits plain HTML files into dist/ — nothing to run, nothing to patch.
  output: 'static',
  build: { format: 'directory' },
});
