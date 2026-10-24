# The source-map fixture

A minified bundle, the map that goes with it, and the two files the map
points at. It is what `scripts/check-error-autofix.mjs` resolves a stack
trace against.

```
maps/js/app-7fJ3k2Q1.js       the bundle, as a browser would load it
maps/js/app-7fJ3k2Q1.js.map   its source map
src/app.js                    the consumer's own code
node_modules/@aws-sdk/…       a dependency, bundled in
```

The check runs the resolver with `MAPS_DIR=maps`: the map of a bundle is the
bundle's own path with `.map` added, and `maps` is the root that path is
relative to.

The stack the fixture answers to is two frames in the same bundle:

```
TypeError: Failed to fetch
    at e (https://app.test/js/app-7fJ3k2Q1.js:1:26)
    at Module.u (https://app.test/js/app-7fJ3k2Q1.js:1:141)
```

The first frame is inside the dependency, the second is the call that made
it. A resolver that takes the first frame it can map lands in
`node_modules` — code nobody can fix. The resolver walks the frames and
takes the first one in the consumer's own code: `src/app.js:7`, the line
that calls the SDK.

The positions were checked against a reference implementation of source map
v3 (`@jridgewell/trace-mapping`), which answers `src/app.js:7:21` for the
second frame. The script reads the map itself — the workflow that runs it
installs no packages — so the check is that the two agree.

## How it was made

```bash
esbuild src/app.js --bundle --minify --format=esm --sourcemap \
  --outfile=maps/js/app-7fJ3k2Q1.js
```

`src/app.js` and `node_modules/@aws-sdk/identity/index.js` are the inputs;
the bundle and the map are the output, copied here unchanged.

The vendor file is under `node_modules` on purpose — that is the path the
resolver looks for to decide that a frame belongs to a dependency and not to
the consumer. `.gitignore` ignores `node_modules/`, so the file carries an
exception.
