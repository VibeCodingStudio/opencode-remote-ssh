import { parse } from "shell-quote";
import path from "node:path";

/** Include the raw command and parsed simple commands, without evaluating variables or shell code. */
export function shellResources(command: string) {
  const result = new Set([command]);
  const normalized = command.replace(/\\\r?\n/g, "");
  for (const text of new Set([normalized, ...normalized.split(/\r?\n/)])) {
    let words: string[] = [];
    const flush = () => {
      while (words[0] && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]) || ["if", "then", "else", "elif", "do", "while", "until", "!", "{"].includes(words[0]))) words.shift();
      if (words.length) result.add(words.join(" "));
      words = [];
    };
    try {
      for (const token of parse(text, key => `$${key}`)) {
        if (typeof token === "string") words.push(token);
        else if ("op" in token && token.op === "glob") words.push(token.pattern);
        else flush();
      }
      flush();
    } catch { /* The original command remains subject to authorization for non-POSIX syntax. */ }
  }
  return [...result];
}
export function outsideDirectory(file: string, directory: string) {
  const relative = path.relative(directory, file);
  return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}
