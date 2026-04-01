import * as esbuild from "esbuild";

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

/** @type {import('esbuild').Plugin} */
const externalizeNonWorkspaceDeps = {
  name: "externalize-non-workspace-deps",
  setup(build) {
    // Externalize all bare-specifier imports except @ragnarok/* workspace packages
    build.onResolve({ filter: /^[^./]/ }, (args) => {
      if (args.path.startsWith("@ragnarok/")) {
        return undefined; // Let esbuild resolve and bundle workspace packages
      }
      return { path: args.path, external: true };
    });
  },
};

const ctx = await esbuild.context({
  entryPoints: ["packages/vscode/dist/extension.js"],
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node20",
  outfile: "dist/extension.js",
  external: ["vscode"],
  sourcemap: !production,
  minify: production,
  plugins: [externalizeNonWorkspaceDeps],
});

if (watch) {
  await ctx.watch();
  console.log("[esbuild] watching for changes...");
} else {
  await ctx.rebuild();
  await ctx.dispose();
  console.log("[esbuild] bundle complete: dist/extension.js");
}
