# Montaj

Week 1 scaffold for the Montaj final project.

## Included

- Next.js App Router scaffold
- Drag-and-drop photo upload with local preview
- Optional Supabase Storage upload when env vars are configured
- Built-in soundtrack picker
- Basic Remotion slideshow preview with fixed 1-second timing

## Run

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

## Supabase setup

Copy `.env.example` to `.env.local` and fill in:

```bash
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
NEXT_PUBLIC_SUPABASE_BUCKET=montaj-media
```

If those vars are missing, uploads still work locally in the browser for the Week 1 demo.
