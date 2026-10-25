// About & claims tab (docs/M5_CONSOLE.md §3). Every sentence comes from text/claims.ts (U-8).
import { TEXT } from "../text/claims";

export function About() {
  return (
    <section className="panel">
      <h3>About & claims</h3>
      <ul>{TEXT.about.map((t) => <li key={t}>{t}</li>)}</ul>
    </section>
  );
}
