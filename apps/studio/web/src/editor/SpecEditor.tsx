import kervanSchema from "@kervan/spec-runtime/schema/kervan.schema.json"
// The editor core with its features, without the bundled languages: only YAML is registered.
import * as monaco from "monaco-editor/esm/vs/editor/edcore.main.js"
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker.js?worker"
import "monaco-editor/esm/vs/basic-languages/yaml/yaml.contribution.js"
import { configureMonacoYaml } from "monaco-yaml"
import { useEffect, useRef } from "react"
import type { Issue } from "../api.js"
import { useIsDark } from "../theme.js"
import YamlWorker from "./yaml.worker.ts?worker"

// Workers come from Studio's own origin (CSP worker-src 'self').
window.MonacoEnvironment = {
  getWorker: (_moduleId: string, label: string) =>
    label === "yaml" ? new YamlWorker() : new EditorWorker(),
}

const MODEL_URI = monaco.Uri.parse("file:///kervan.yaml")

// The editor schema bundled from @kervan/spec-runtime; never fetched from the network. Its `$id`
// is only a name for it here.
configureMonacoYaml(monaco, {
  enableSchemaRequest: false,
  hover: true,
  completion: true,
  validate: true,

  schemas: [
    {
      uri: kervanSchema.$id,
      fileMatch: ["kervan.yaml"],
      schema: kervanSchema as never,
    },
  ],
})

// The editor's colors follow Studio's surface tokens (theme.css), in both themes.
monaco.editor.defineTheme("kervan-light", {
  base: "vs",
  inherit: true,
  rules: [],
  colors: { "editor.background": "#ffffff", "editorGutter.background": "#ffffff" },
})
monaco.editor.defineTheme("kervan-dark", {
  base: "vs-dark",
  inherit: true,
  rules: [],
  colors: {
    "editor.background": "#181716",
    "editorGutter.background": "#181716",
    "editor.lineHighlightBackground": "#201e1c",
  },
})

function toTop(instance: monaco.editor.IStandaloneCodeEditor): void {
  instance.setPosition({ lineNumber: 1, column: 1 })
  instance.setScrollTop(0)
  instance.setScrollLeft(0)
}

/** Monaco with kervan.yaml completion and validation, plus the server's own issues as markers. */
export default function SpecEditor(props: {
  value: string
  onChange: (value: string) => void
  issues: readonly Issue[]
}) {
  const container = useRef<HTMLDivElement>(null)
  const editor = useRef<monaco.editor.IStandaloneCodeEditor>(undefined)
  const onChange = useRef(props.onChange)
  onChange.current = props.onChange
  const dark = useIsDark()

  // biome-ignore lint/correctness/useExhaustiveDependencies: created once; value syncs below
  useEffect(() => {
    if (!container.current) return
    const model =
      monaco.editor.getModel(MODEL_URI) ?? monaco.editor.createModel(props.value, "yaml", MODEL_URI)
    const instance = monaco.editor.create(container.current, {
      model,
      automaticLayout: true,
      minimap: { enabled: false },
      tabSize: 2,
      scrollBeyondLastLine: false,
      theme: dark ? "kervan-dark" : "kervan-light",
      fontSize: 13,
      // Long descriptions and selects wrap, indented, instead of running off the side.
      wordWrap: "on",
      wrappingIndent: "indent",
      padding: { top: 8 },
    })
    editor.current = instance
    toTop(instance)
    const subscription = model.onDidChangeContent(() => onChange.current(model.getValue()))
    return () => {
      subscription.dispose()
      instance.dispose()
      model.dispose()
    }
  }, [])

  useEffect(() => {
    const instance = editor.current
    const model = instance?.getModel()
    if (!instance || !model || model.getValue() === props.value) return
    // A version opened (or the starter) starts at its first line, not where the last one was.
    model.setValue(props.value)
    toTop(instance)
  }, [props.value])

  // Monaco's theme is global; there is one editor on the page.
  useEffect(() => monaco.editor.setTheme(dark ? "kervan-dark" : "kervan-light"), [dark])

  useEffect(() => {
    const model = editor.current?.getModel()
    if (!model) return
    // Marker messages are plain text in Monaco (no HTML).
    monaco.editor.setModelMarkers(
      model,
      "kervan",
      props.issues
        .filter((issue) => issue.line !== undefined)
        .map((issue) => ({
          severity:
            issue.severity === "error"
              ? monaco.MarkerSeverity.Error
              : monaco.MarkerSeverity.Warning,
          message: issue.message,
          startLineNumber: issue.line ?? 1,
          startColumn: issue.column ?? 1,
          endLineNumber: issue.line ?? 1,
          endColumn: model.getLineMaxColumn(issue.line ?? 1),
        })),
    )
  }, [props.issues])

  return <div className="h-[60vh] min-h-80" ref={container} data-testid="spec-editor" />
}
