import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["./src/app.ts"],
  clean: true,
  noExternal: [/(.*)/],
});
