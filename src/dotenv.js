// Minimal .env parser: KEY=VALUE lines, optional `export ` prefix, `#` comments, and single- or
// double-quoted values. Deliberately no variable expansion or multi-line values — it only needs to
// read the handful of secrets a claude-pod.config.json interpolates.

export function parseDotenv(text) {
  const vars = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    const [, key, rest] = m;
    let value = rest;
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.indexOf(quote, 1) !== -1) {
      value = value.slice(1, value.indexOf(quote, 1));
      if (quote === '"') value = value.replace(/\\n/g, '\n').replace(/\\"/g, '"');
    } else {
      // Unquoted: strip a trailing inline comment (" #...").
      value = value.replace(/\s+#.*$/, '').trim();
    }
    // First definition wins, matching `grep ... | head -1` in the old launcher scripts.
    if (!(key in vars)) vars[key] = value;
  }
  return vars;
}
