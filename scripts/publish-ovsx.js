const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

// 1. Load .env file if present
const envPath = path.join(__dirname, "..", ".env");
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, "utf8");
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("#")) {
      const idx = trimmed.indexOf("=");
      if (idx > 0) {
        const key = trimmed.slice(0, idx).trim();
        const value = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
        if (!process.env[key]) {
          process.env[key] = value;
        }
      }
    }
  }
}

// 2. Check token
const token = process.env.OPEN_VSX_TOKEN;
if (!token || token === "your_open_vsx_token_here") {
  console.error("\n❌ OPEN_VSX_TOKEN not found in .env file or environment!");
  console.error("Please create a .env file in project root with:");
  console.error("OPEN_VSX_TOKEN=your_token_from_open_vsx_org\n");
  process.exit(1);
}

// 3. Read package.json version & publisher
const pkgPath = path.join(__dirname, "..", "package.json");
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
const version = pkg.version;
const publisher = pkg.publisher;
const vsixName = `promptpilot-${version}.vsix`;
const vsixPath = path.join(__dirname, "..", vsixName);

console.log(`\n🚀 Preparing to publish PromptPilot v${version} to Open VSX...`);

// 4. Ensure VSIX package is built
if (!fs.existsSync(vsixPath)) {
  console.log(`📦 Packaging ${vsixName}...`);
  execSync("npx vsce package", { stdio: "inherit", cwd: path.join(__dirname, "..") });
}

// 5. Ensure namespace exists on Open VSX
try {
  console.log(`🔑 Ensuring namespace '${publisher}' exists...`);
  execSync(`npx ovsx create-namespace ${publisher} -p ${token}`, { stdio: "pipe" });
} catch {
  // Namespace likely already exists, ignore error and continue
}

// 6. Publish to Open VSX
console.log(`📤 Publishing ${vsixName} to Open VSX...`);
try {
  execSync(`npx ovsx publish ${vsixName} -p ${token}`, {
    stdio: "inherit",
    cwd: path.join(__dirname, ".."),
  });
  console.log(`\n✅ Successfully published PromptPilot v${version} to Open VSX! 🎉\n`);
} catch (err) {
  console.error(`\n❌ Failed to publish: ${err.message}\n`);
  process.exit(1);
}
