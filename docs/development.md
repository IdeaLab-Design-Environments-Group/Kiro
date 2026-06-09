# Development

This repo is a Vite/TypeScript app. The current conversion pipeline is still a
passthrough stub for FOLD/FKLD files, with mesh import reserved for the future
Kirigamizer conversion pipeline.

## Commands

```sh
npm install
npm run dev
npm run build
npm run preview
```

`npm run build` runs `tsc --noEmit` and then `vite build`. Use it after changes
to imports, architecture, or simulation code.

## Node Version Note

The current machine may print an npm warning when run under Node 18.15.0:

```text
npm v11.2.0 does not support Node.js v18.15.0
```

The project still builds, but a Node version matching npm's supported range is
preferred for regular development.

## Adding Features

Use the MVC boundary when adding code:

- Add state or pure calculations under `src/model/`.
- Add DOM/WebGL UI under `src/view/`.
- Add app orchestration under `src/controller/`.
- Add folding physics or scene construction under `src/sim/`.
- Keep `src/main.ts` as a composition root.

Examples:

- New metadata row: update `src/model/fkld-metadata.ts`, then render through
  `MetadataPanel`.
- New file-derived fact: update `src/model/derive-facts.ts`.
- New button: add it to a view, expose an `on...` handler, and wire it in
  `AppController`.
- New simulation path: add a scene builder in `src/sim/`, then choose it from
  `src/sim/scene.ts`.

## Testing Expectations

At minimum, run:

```sh
npm run build
```

For simulation changes, also test a small hinge or simple crease pattern before
testing complex FKLD files. The most useful first check is whether positive and
negative target fold angles settle to positive and negative measured theta.

## Generated Files

`dist/` is Vite output. Do not edit it by hand. Rebuild it with:

```sh
npm run build
```

`public/examples/` contains source examples served by Vite. Add examples there,
then rebuild if `dist/` needs to include them.

