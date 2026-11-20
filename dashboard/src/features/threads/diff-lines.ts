export type LineKind = "add" | "del" | "hunk" | "meta" | "ctx";

export function lineKind(line: string): LineKind {
  if (line.startsWith("@@")) return "hunk";
  if (
    line.startsWith("+++") ||
    line.startsWith("---") ||
    /^(diff --git|index |new file|deleted file|similarity|rename |old mode|new mode|Binary files)/.test(
      line,
    )
  )
    return "meta";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "ctx";
}
