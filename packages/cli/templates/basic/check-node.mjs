// Runs before `npm start`: this project's sources are TypeScript that Node.js runs directly (type
// stripping), on the Node.js releases Kervan is tested on (package.json "engines"). Older versions
// would fail with a cryptic ERR_UNKNOWN_FILE_EXTENSION, or worse, instead of this message.
const engines = "{{nodeEngines}}"
const parse = (text) => text.split(".").map(Number)
const atLeast = (version, floor) => {
  for (let i = 0; i < 3; i++) if (version[i] !== floor[i]) return version[i] > floor[i]
  return true
}
const current = parse(process.versions.node)
const supported = engines.split("||").some((part) => {
  const [, kind, floor] = /^\s*(\^|>=)(\d+\.\d+\.\d+)\s*$/.exec(part) ?? []
  if (!floor) return false
  const wanted = parse(floor)
  return atLeast(current, wanted) && (kind === ">=" || current[0] === wanted[0])
})
if (!supported) {
  console.error(
    `This project needs Node.js ${engines} to run its TypeScript sources; ` +
      `you have ${process.versions.node}. Upgrade Node.js.`,
  )
  process.exit(1)
}
