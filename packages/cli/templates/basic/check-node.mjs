// Runs before `npm start`: this project's sources are TypeScript that Node.js runs directly (type
// stripping), which needs Node.js 22.18+ or 23.6+. Older versions would fail with a cryptic
// ERR_UNKNOWN_FILE_EXTENSION instead of this message.
const [major, minor] = process.versions.node.split(".").map(Number)
const supported = major > 23 || (major === 23 && minor >= 6) || (major === 22 && minor >= 18)
if (!supported) {
  console.error(
    `This project needs Node.js 22.18 or newer (or 23.6+) to run its TypeScript sources; ` +
      `you have ${process.versions.node}. Upgrade Node.js.`,
  )
  process.exit(1)
}
