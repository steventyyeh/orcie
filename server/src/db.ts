import { DatabaseSync } from "node:sqlite";

// On-prem conversation store: one local SQLite file (WAL) holding agents, conversations, members, messages,
// per-agent delivery cursors, and a full-text index over message text. Nothing leaves this machine.
export function openDb(path: string) {
  const db = new DatabaseSync(path);
  db.exec(`
    pragma journal_mode = wal;
    create table if not exists agents (name text primary key, model text not null, container text not null, created text not null, profile text);
    create table if not exists conversations (id text primary key, kind text not null, title text not null, mode text, created text not null);
    create table if not exists members (conv text not null, name text not null, primary key (conv, name));
    create table if not exists messages (conv text not null, seq integer not null, sender text not null, text text not null, at text not null, hop integer, activity text, primary key (conv, seq));
    create index if not exists messages_at on messages (at);
    create table if not exists cursors (conv text not null, agent text not null, seq integer not null, primary key (conv, agent));
    create virtual table if not exists messages_fts using fts5(text, conv unindexed, seq unindexed, sender unindexed, tokenize = 'porter unicode61');
  `);
  const q = (sql: string) => db.prepare(sql);
  const tx = (fn: () => void) => { db.exec("begin"); try { fn(); db.exec("commit"); } catch (e) { db.exec("rollback"); throw e; } };

  const putAgent = q("insert into agents (name, model, container, created, profile) values (?, ?, ?, ?, ?) on conflict(name) do update set model = excluded.model, container = excluded.container, profile = excluded.profile");
  const putConv = q("insert into conversations (id, kind, title, mode, created) values (?, ?, ?, ?, ?) on conflict(id) do update set title = excluded.title, mode = excluded.mode");
  const addMember = q("insert or ignore into members (conv, name) values (?, ?)");
  const addMsg = q("insert or replace into messages (conv, seq, sender, text, at, hop, activity) values (?, ?, ?, ?, ?, ?, ?)");
  const addFts = q("insert into messages_fts (text, conv, seq, sender) values (?, ?, ?, ?)");
  const setCur = q("insert into cursors (conv, agent, seq) values (?, ?, ?) on conflict(conv, agent) do update set seq = excluded.seq");

  // Turn free text into a safe FTS5 query: quoted tokens, prefix match on each.
  const ftsQuery = (s: string) => (s.match(/[\p{L}\p{N}_-]+/gu) ?? []).map((t) => `"${t.replace(/"/g, "")}"*`).join(" ");

  return {
    loadAll() {
      const agents: Record<string, any> = {}, convs: Record<string, any> = {};
      for (const r of q("select * from agents").all() as any[]) agents[r.name] = { name: r.name, model: r.model, container: r.container, port: 0, created: r.created, ...(r.profile ? { profile: JSON.parse(r.profile) } : {}) };
      for (const r of q("select * from conversations order by created").all() as any[]) convs[r.id] = { id: r.id, kind: r.kind, title: r.title, mode: r.mode ?? undefined, members: [], messages: [], cursor: {} };
      for (const r of q("select * from members").all() as any[]) convs[r.conv]?.members.push(r.name);
      for (const r of q("select * from messages order by conv, seq").all() as any[])
        convs[r.conv]?.messages.push({ seq: r.seq, from: r.sender, text: r.text, at: r.at, ...(r.hop != null ? { hop: r.hop } : {}), ...(r.activity ? { activity: JSON.parse(r.activity) } : {}) });
      for (const r of q("select * from cursors").all() as any[]) if (convs[r.conv]) convs[r.conv].cursor[r.agent] = r.seq;
      return { agents, convs };
    },
    putAgent: (a: any) => void putAgent.run(a.name, a.model, a.container, a.created, a.profile ? JSON.stringify(a.profile) : null),
    delAgent: (name: string) => void q("delete from agents where name = ?").run(name),
    putConv: (c: any) => tx(() => { putConv.run(c.id, c.kind, c.title, c.mode ?? null, new Date().toISOString()); for (const m of c.members) addMember.run(c.id, m); }),
    addMsg: (conv: string, m: any) => tx(() => {
      addMsg.run(conv, m.seq, m.from, m.text, m.at, m.hop ?? null, m.activity ? JSON.stringify(m.activity) : null);
      if (m.from !== "system") addFts.run(m.text, conv, m.seq, m.from);
    }),
    setCursor: (conv: string, agent: string, seq: number) => void setCur.run(conv, agent, seq),
    count: () => (q("select count(*) n from conversations").get() as any).n as number,
    search(text: string, limit = 30) {
      const fq = ftsQuery(text); if (!fq) return [];
      return q(`select f.conv, f.seq, f.sender as "from", m.at, c.title, c.kind, snippet(messages_fts, 0, '[[', ']]', '…', 14) as snippet
                from messages_fts f join messages m on m.conv = f.conv and m.seq = f.seq join conversations c on c.id = f.conv
                where messages_fts match ? order by rank limit ?`).all(fq, limit);
    },
  };
}
