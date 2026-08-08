// Ambient declaration for Bun's TOML imports (`with { type: "toml" }`).
// Resolved by the Bun runtime; typed here for tsc.
declare module "*.toml" {
  const value: unknown;
  export default value;
}
