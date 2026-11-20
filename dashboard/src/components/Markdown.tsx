import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";

/** Vault links read as their title: [[a/b-c|Name]] → Name, [[a/b-c]] → b c. */
export function withoutWikilinks(text: string) {
  return text
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, (_, path: string) =>
      path.split("/").at(-1)!.replace(/\.md$/, "").replace(/-/g, " "),
    );
}

/**
 * Escapes currency dollar amounts (e.g. `$1,200.00`) outside fenced/inline code
 * and display math (`$$...$$`) so remark-math does not parse them as KaTeX.
 */
export function escapeCurrencyDollars(source: string): string {
  return source
    .split(/(```[\s\S]*?```|`[^`\n]+`|\$\$[\s\S]*?\$\$)/g)
    .map((segment, i) =>
      i % 2 === 1
        ? segment
        : segment.replace(
            /(^|[^\w\\$])\$(\d[\d,]*(?:\.\d+)?)(?![^\s$]*\$(?!\d))/gm,
            "$1\\$$$2",
          ),
    )
    .join("");
}

/** Agent Markdown (results, daily note). Raw HTML is never rendered. */
export function Markdown({ texto: text }: { texto: string }) {
  const withoutFrontmatter = text.replace(
    /^---\r?\n[\s\S]*?\r?\n---\r?\n?/,
    "",
  );
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[[rehypeKatex, { throwOnError: false, strict: false }]]}
        skipHtml
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer noopener">
              {children}
            </a>
          ),
        }}
      >
        {escapeCurrencyDollars(withoutWikilinks(withoutFrontmatter))}
      </ReactMarkdown>
    </div>
  );
}
