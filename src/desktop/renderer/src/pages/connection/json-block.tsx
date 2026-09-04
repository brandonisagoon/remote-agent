import { Fragment } from "react";

/** Lightweight JSON syntax highlighting using theme chart tokens — enough for
    small illustrative snippets without pulling in a highlighter. */
function highlight(json: string): React.ReactNode[] {
  const pattern = /("(?:[^"\\]|\\.)*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?)/g;
  const nodes: React.ReactNode[] = [];
  let cursor = 0;
  let key = 0;
  for (const match of json.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > cursor) nodes.push(<Fragment key={key++}>{json.slice(cursor, index)}</Fragment>);
    const [full, string, colon, keyword, number] = match;
    if (string !== undefined) {
      nodes.push(
        <span key={key++} className={colon ? "text-foreground" : "text-chart-2"}>
          {string}
        </span>,
      );
      if (colon) nodes.push(<Fragment key={key++}>{colon}</Fragment>);
    } else if (keyword !== undefined) {
      nodes.push(<span key={key++} className="text-chart-1">{keyword}</span>);
    } else if (number !== undefined) {
      nodes.push(<span key={key++} className="text-chart-1">{number}</span>);
    } else {
      nodes.push(<Fragment key={key++}>{full}</Fragment>);
    }
    cursor = index + full.length;
  }
  if (cursor < json.length) nodes.push(<Fragment key={key++}>{json.slice(cursor)}</Fragment>);
  return nodes;
}

export function JsonBlock({ label, json }: { label: string; json: string }) {
  return (
    <div className="grid gap-1.5">
      <span className="text-muted-foreground text-xs italic">{label}</span>
      <pre className="bg-secondary/50 text-muted-foreground -mx-4 overflow-x-auto rounded-lg p-4 font-mono text-xs leading-relaxed">
        {highlight(json)}
      </pre>
    </div>
  );
}
