/**
 * Publisher-written prose with its markdown rendered, and still never as HTML.
 *
 * `lib/markdown.ts` parses the text to a tree; this walks the tree and emits React elements whose
 * children are strings. React escapes those strings, so `<img src=x onerror=…>` in a description
 * is the characters `<img src=x onerror=…>` on screen, exactly as `UntrustedBlock` showed them.
 * Links are the one place a publisher's input becomes an attribute, and only an http(s) address
 * passes the parser to get there; every link opens in a new tab with `noopener noreferrer`.
 */
import { type Block, type Inline, parseMarkdown } from "@/lib/markdown";
import type { ReactNode } from "react";

export function UntrustedMarkdown({
  value,
  fallback = "No description was provided.",
}: {
  value: string | null | undefined;
  fallback?: string;
}) {
  if (value === null || value === undefined || value.trim() === "") {
    return <p className="muted">{fallback}</p>;
  }
  return <div className="untrusted-markdown">{parseMarkdown(value).map(renderBlock)}</div>;
}

function renderBlock(block: Block, index: number): ReactNode {
  const key = `${block.kind}-${index}`;
  switch (block.kind) {
    case "heading": {
      // Every level renders as an h3: the page owns its h1 and h2s, and a publisher's "#" is a
      // bold line inside their own text, not a section of ours.
      return <h3 key={key}>{block.children.map(renderInline)}</h3>;
    }
    case "list": {
      const items = block.items.map((item, position) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: items have no identity beyond position
        <li key={position}>{item.map(renderInline)}</li>
      ));
      return block.ordered ? <ol key={key}>{items}</ol> : <ul key={key}>{items}</ul>;
    }
    default:
      return <p key={key}>{block.children.map(renderInline)}</p>;
  }
}

function renderInline(node: Inline, index: number): ReactNode {
  const key = `${node.kind}-${index}`;
  switch (node.kind) {
    case "text":
      return node.value;
    case "break":
      return <br key={key} />;
    case "code":
      return <code key={key}>{node.value}</code>;
    case "strong":
      return <strong key={key}>{node.children.map(renderInline)}</strong>;
    case "em":
      return <em key={key}>{node.children.map(renderInline)}</em>;
    case "link":
      return (
        <a key={key} href={node.href} target="_blank" rel="noopener noreferrer">
          {node.children.map(renderInline)}
        </a>
      );
    default:
      return null;
  }
}
