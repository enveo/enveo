declare const node: { innerHTML: string };

// biome-ignore lint/complexity/useLiteralKeys: fixture covers computed literal property scanning
node["innerHTML"] = "fixture";
