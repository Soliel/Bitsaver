# BitSaver

A crafting assistant for [Bitcraft](https://bitcraftonline.com/). Create crafting lists, track recipes, and manage your inventory.

## Features

- **Crafting Lists** - Create and manage lists of items you want to craft
- **Recipe Browser** - Browse all craftable items and their recipes
- **Inventory Sync** - Connect to Bitjita API to track your in-game inventory
- **Material Calculator** - Automatically calculates required materials for recipes

## Tech Stack

- [SvelteKit](https://kit.svelte.dev/) with Svelte 5
- [Tailwind CSS](https://tailwindcss.com/) v4
- [IndexedDB](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API) for client-side storage
- Deployed on [Vercel](https://vercel.com/)

## Development

```bash
# Install dependencies
npm install

# Start dev server
npm run dev

# Type check
npm run check

# Build for production
npm run build
```

## Project Structure

```
src/
├── lib/
│   ├── components/    # Reusable UI components
│   ├── services/      # API clients and external services
│   └── state/         # Svelte 5 runes-based state management
├── routes/
│   ├── items/         # Item browser
│   ├── lists/         # Crafting lists
│   ├── inventory/     # Inventory viewer
│   └── settings/      # App settings
└── static/            # Static assets (icons, game data)
```

## API

BitSaver uses the [Bitjita](https://bitjita.com/) API to fetch player inventories and claim data.
