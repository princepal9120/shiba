// Worker assets serve app.tryshiba.dev; redirects there loop or fail Wrangler validation (code 100324).
export function workerRedirects(text) {
  return text
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();
      if (trimmed === "" || trimmed.startsWith("#")) return true;
      const destination = trimmed.split(/\s+/)[1];
      return !/^https?:\/\//i.test(destination ?? "");
    })
    .join("\n");
}
