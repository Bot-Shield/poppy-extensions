/**
 * The demo page: three lanes (the fan's chat · the exchange · the account holder's phone), replaying
 * runs recorded against BotShield's production sandbox with a real phone and a real passkey.
 */
import refund from '../replay/refund.json';
import presale from '../replay/presale.json';

type Entry = { at: string; flow: string; lane: 'assistant' | 'company' | 'botshield' | 'phone'; title: string; detail?: unknown };

/** What each side "thinks" at a step. Keyed by the trace title's start. */
const REASONING: Array<[RegExp, string, string[]]> = [
  [/^Refund \d tickets/, 'Assistant', ['The fan asked for a refund to a new card.', 'Calls Couch Tour’s refund tool. Declares botshield.ai/approval.']],
  [/^Asked the account holder/, 'Couch Tour', ['A refund to a different card is the classic fraud move. Only the account holder may approve it.', 'Refunds nothing. Asks the account holder through BotShield and answers 403 account_holder_approval_required.']],
  [/^Signed answer checked once: the account holder/, 'BotShield → Couch Tour', ['The account holder approved these exact terms with their passkey.', 'Couch Tour checks BotShield’s signed answer, once. It names no person.']],
  [/^Refunded, once/, 'Couch Tour', ['Approved, signed, checked. The refund runs, at most once.']],
  [/^Already refunded/, 'Couch Tour', ['The assistant sent the same request again.', 'Same answer as before. Nothing is refunded twice.']],
  [/^Enter the presale/, 'Assistant', ['Asks to enter the presale. Declares botshield.ai/human-presence.']],
  [/^A person must confirm/, 'Couch Tour', ['One entry per person. An assistant can make any number of chats, so a chat proves nothing.', 'Answers 403 human_presence_required with a BotShield link.']],
  [/^Signed answer checked once: a person/, 'BotShield → Couch Tour', ['The person confirmed with their passkey, and the gate counted them once.', 'Couch Tour gets pass or refused. No identity travels.']],
  [/^Entered/, 'Couch Tour', ['A person was here, counted once. Entry recorded.']],
  [/^Check ended: refused/, 'Couch Tour', ['BotShield: already used, one per verified phone number.', 'Same person, new chat. Refused, and Couch Tour never learned it was the same person.']],
];

type Scene = { id: string; label: string; recorded: string; chat: Array<[('fan' | 'agent'), string]>; entries: Entry[]; phone: Array<{ after: number; title: string; lines: string[]; state: 'ask' | 'ok' | 'no' }> };

function scenes(): Scene[] {
  const r = (refund as { entries: Entry[] }).entries;
  const p = (presale as { entries: Entry[] }).entries;
  const firstRefused = p.findIndex((e) => /^Check ended: refused/.test(e.title));
  const secondStart = p.findIndex((e, i) => i > 0 && /^Enter the presale/.test(e.title) && p[i - 1] && /^Entered/.test(p[i - 1].title));
  return [
    {
      id: 'refund', label: 'Refund to a new card', recorded: 'Recorded Nov 18, 2026 · BotShield production sandbox · a real passkey',
      chat: [
        ['fan', 'Refund my Red Rocks tickets to my card ending 4417.'],
        ['agent', 'Couch Tour needs the account holder to approve a refund to a different card. Check the BotShield app on your phone.'],
        ['fan', 'Approved.'],
        ['agent', 'Done: $96.00 is going back to the card ending 4417.'],
      ],
      entries: r,
      phone: [
        { after: 1, title: 'Couch Tour', lines: ['Refund 2 tickets to a different card, ending 4417', 'Show · Rising Wave Live · Red Rocks', 'Tickets · 2 × $48.00', 'Total · $96.00'], state: 'ask' },
        { after: 3, title: 'Approved with your passkey', lines: ['Refund 2 tickets to a different card, ending 4417', 'Total · $96.00'], state: 'ok' },
      ],
    },
    {
      id: 'presale', label: 'Enter the presale', recorded: 'Recorded Nov 18, 2026 · BotShield production sandbox · a real passkey',
      chat: [
        ['fan', 'Get me into the Red Rocks presale.'],
        ['agent', 'Couch Tour wants a person to confirm. Open the BotShield link on your phone.'],
        ['agent', 'You’re in.'],
      ],
      entries: p.slice(0, secondStart > 0 ? secondStart : p.length),
      phone: [
        { after: 1, title: 'Couch Tour', lines: ['Rising Wave Live · Red Rocks presale', 'One entry per person'], state: 'ask' },
        { after: 3, title: 'Confirmed with your passkey', lines: ['Rising Wave Live · Red Rocks presale'], state: 'ok' },
      ],
    },
    {
      id: 'again', label: 'Try the presale again', recorded: 'Recorded Nov 18, 2026 · the same person, a new chat',
      chat: [
        ['fan', 'New chat. Get me into the Red Rocks presale.'],
        ['agent', 'Couch Tour wants a person to confirm. Open the BotShield link on your phone.'],
        ['agent', 'Couch Tour says no: one entry per person, and you already have yours.'],
      ],
      entries: secondStart > 0 ? p.slice(secondStart, firstRefused + 1) : [],
      phone: [
        { after: 1, title: 'Couch Tour', lines: ['Rising Wave Live · Red Rocks presale', 'One entry per person'], state: 'ask' },
        { after: 3, title: 'Already used', lines: ['One per verified phone number.'], state: 'no' },
      ],
    },
  ];
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function demoPage(): string {
  const data = scenes().map((s) => ({
    ...s,
    entries: s.entries.map((e, i) => {
      const r = REASONING.find(([re]) => re.test(e.title));
      // A repeated assistant request is a retry: say so, rather than repeat the first step's words.
      const seen = e.lane === 'assistant' && s.entries.slice(0, i).some((x) => x.lane === 'assistant' && x.title === e.title);
      const after = s.entries.slice(0, i).reverse().find((x) => x.lane !== 'assistant')?.title ?? '';
      const why = !seen ? (r?.[2] ?? [])
        : /^Refunded|^Entered/.test(after) ? ['Sends the same request once more, as an assistant might.']
        : /presale/i.test(e.title) ? ['The person confirmed on their phone. Repeats the request with the presence ID.']
        : ['The account holder approved on their phone. Repeats the request with the approval ID.'];
      return { lane: e.lane, title: seen ? `${e.title} (again)` : e.title, time: e.at.slice(11, 19), who: r?.[1] ?? '', why, detail: e.detail ?? null };
    }),
  }));
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Couch Tour · Poppy demo</title>
<meta name="description" content="A person's assistant asks Couch Tour for a refund and a presale entry. BotShield asks the account holder, on their own phone.">
<style>
:root{--bg:#0b0c0e;--surface:#141518;--raised:#1b1f24;--stroke:#2a2f36;--text:#fff;--text2:#c9ccd1;--dim:#7b8189;--mint:#bfffec;--on-mint:#0d1714;--bs:#1a9fd6;--ok:#3fd68f;--no:#ff6b5e}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 Inter,ui-sans-serif,system-ui,-apple-system,sans-serif}
.wrap{max-width:1280px;margin:0 auto;padding:24px 16px 64px}
header{display:flex;flex-wrap:wrap;gap:16px;align-items:baseline;justify-content:space-between}
h1{margin:0;font-size:22px;letter-spacing:-.01em}h1 b{color:var(--mint);font-weight:700}
.sub{color:var(--text2);max-width:62ch;margin:6px 0 0}
.tabs{display:flex;flex-wrap:wrap;gap:8px;margin:20px 0 6px}
.tab{background:var(--surface);color:var(--text2);border:1px solid var(--stroke);border-radius:999px;padding:8px 14px;font:inherit;cursor:pointer}
.tab[aria-selected=true]{background:var(--mint);color:var(--on-mint);border-color:var(--mint);font-weight:600}
.tab:focus-visible,.play:focus-visible{outline:2px solid var(--bs);outline-offset:2px}
.rec{color:var(--dim);font:12px ui-monospace,'SF Mono',Menlo,monospace;letter-spacing:.02em}
.grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.6fr) minmax(0,.9fr);gap:16px;margin-top:16px}
@media (max-width:980px){.grid{grid-template-columns:1fr}}
.col{min-width:0;overflow-wrap:anywhere;background:var(--surface);border:1px solid var(--stroke);border-radius:16px;padding:16px;min-height:420px}
.col h2{margin:0 0 12px;font:600 11px ui-monospace,Menlo,monospace;letter-spacing:.14em;color:var(--dim);text-transform:uppercase}
.msg{max-width:88%;padding:10px 12px;border-radius:14px;margin:0 0 10px;opacity:.25;transition:opacity .3s}
.msg.on{opacity:1}.msg.fan{margin-left:auto;background:var(--mint);color:var(--on-mint);border-bottom-right-radius:4px}
.msg.agent{background:var(--raised);border-bottom-left-radius:4px}
.step{border-left:2px solid var(--stroke);padding:2px 0 14px 14px;position:relative;opacity:.25;transition:opacity .3s}
.step.on{opacity:1}.step::before{content:'';position:absolute;left:-6px;top:6px;width:10px;height:10px;border-radius:50%;background:var(--stroke)}
.step.assistant::before{background:var(--text2)}.step.company::before{background:var(--mint)}.step.botshield::before{background:var(--bs)}
.step .t{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}.step .t time{color:var(--dim);font:12px ui-monospace,Menlo,monospace}
.lane{font:600 10px ui-monospace,Menlo,monospace;letter-spacing:.12em;text-transform:uppercase;color:var(--dim)}
.step.botshield .lane{color:var(--bs)}.step.company .lane{color:var(--mint)}
.why{margin:6px 0 0;padding:8px 10px;background:var(--raised);border-radius:8px;color:var(--text2);font-size:13.5px}
.why ol{margin:0;padding-left:18px}
details{margin-top:6px}summary{cursor:pointer;color:var(--dim);font-size:12.5px}
pre{margin:6px 0 0;padding:10px;background:#0e1013;border:1px solid var(--stroke);border-radius:8px;overflow-x:auto;font:12px/1.45 ui-monospace,Menlo,monospace;color:var(--text2)}
.phone{border:2px solid #2c3138;border-radius:28px;padding:18px 14px;min-height:360px;background:#08090b}
.pbar{font:600 11px ui-monospace,Menlo,monospace;letter-spacing:.12em;color:var(--dim);text-align:center;margin-bottom:14px}
.card{border:1px solid var(--stroke);border-radius:16px;padding:14px;background:var(--surface);display:none}
.card.on{display:block}.card h3{margin:0 0 8px;font-size:15px}
.card p{margin:2px 0;color:var(--text2);font-size:13.5px}
.btn{margin-top:12px;border-radius:12px;padding:10px;text-align:center;font-weight:600;border:1px solid var(--stroke)}
.ask .btn{color:var(--text)}.ok .btn{color:var(--ok);border-color:var(--ok)}.no .btn{color:var(--no);border-color:var(--no)}
.empty{color:var(--dim);font-size:13.5px;text-align:center;margin-top:40px}
.bar{display:flex;gap:12px;align-items:center;margin-top:16px;flex-wrap:wrap}
.play{background:var(--mint);color:var(--on-mint);border:0;border-radius:12px;padding:10px 16px;font:600 15px Inter,system-ui,sans-serif;cursor:pointer}
.foot{margin-top:28px;color:var(--dim);font-size:13px;max-width:80ch}.foot a{color:var(--text2)}
@media (prefers-reduced-motion:reduce){.msg,.step{transition:none}}
</style></head><body><div class="wrap">
<header><div><h1><b>Couch Tour</b> · Poppy demo</h1>
<p class="sub">A fan’s assistant talks to Couch Tour through the Personal Agent Protocol. When it matters, BotShield asks the account holder on their own phone. The assistant can’t approve anything.</p></div></header>
<div class="tabs" role="tablist">${data.map((s, i) => `<button class="tab" role="tab" id="tab-${s.id}" aria-selected="${i === 0}" data-i="${i}">${esc(s.label)}</button>`).join('')}</div>
<div class="rec" id="rec"></div>
<div class="grid">
  <section class="col" aria-label="The fan's chat"><h2>The fan and their assistant</h2><div id="chat"></div></section>
  <section class="col" aria-label="The exchange"><h2>Assistant ⇄ Couch Tour ⇄ BotShield</h2><div id="steps"></div></section>
  <section class="col" aria-label="The account holder's phone"><h2>The account holder’s phone</h2><div class="phone"><div class="pbar">BOTSHIELD</div><div id="phone"><p class="empty">Nothing yet.</p></div></div></section>
</div>
<div class="bar"><button class="play" id="play">Play</button><span class="rec">Step through it, or play it.</span><button class="tab" id="next">Next step</button></div>
<p class="foot">Real runs: recorded against BotShield’s production sandbox, with a real phone and a real passkey. The extensions are open source: <a href="https://github.com/Bot-Shield/poppy-extensions">github.com/Bot-Shield/poppy-extensions</a> · <a href="/.well-known/poppy.json">this demo’s poppy.json</a>. A demo, not Couch Tour’s live service: the assistant acts for one demo customer who is already signed in. A real Couch Tour knows the customer from the agent’s Poppy sign-in, and BotShield reaches only the person who linked that account.</p>
</div>
<script>
const DATA=${JSON.stringify(data).replace(/</g, '\\u003c')};
let cur=0,step=0,timer=null;
const $=(id)=>document.getElementById(id);
const esc=(s)=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
function render(){const s=DATA[cur];$('rec').textContent=s.recorded;
 const chatOn=Math.min(s.chat.length,Math.ceil((step/Math.max(1,s.entries.length))*s.chat.length));
 $('chat').innerHTML=s.chat.map((m,i)=>'<div class="msg '+m[0]+(i<Math.max(1,chatOn)?' on':'')+'">'+esc(m[1])+'</div>').join('');
 $('steps').innerHTML=s.entries.map((e,i)=>'<div class="step '+e.lane+(i<step?' on':'')+'"><div class="t"><span class="lane">'+esc(e.who||e.lane)+'</span><time>'+e.time+'</time></div><div>'+esc(e.title)+'</div>'+(e.why.length&&i<step?'<div class="why"><ol>'+e.why.map(w=>'<li>'+esc(w)+'</li>').join('')+'</ol></div>':'')+(e.detail&&i<step?'<details><summary>What was sent</summary><pre>'+esc(JSON.stringify(e.detail,null,2))+'</pre></details>':'')+'</div>').join('')||'<p class="empty">No recording yet.</p>';
 const card=[...s.phone].reverse().find(p=>step>p.after);
 $('phone').innerHTML=card?'<div class="card on '+card.state+'"><h3>'+esc(card.title)+'</h3>'+card.lines.map(l=>'<p>'+esc(l)+'</p>').join('')+'<div class="btn">'+(card.state==='ask'?'Approve with passkey':card.state==='ok'?'Approved':'Not allowed')+'</div></div>':'<p class="empty">Nothing yet.</p>';
 document.querySelectorAll('.tab[role=tab]').forEach((t,i)=>t.setAttribute('aria-selected',String(i===cur)));
 $('play').textContent=timer?'Pause':(step>=s.entries.length?'Replay':'Play');}
function next(){const s=DATA[cur];if(step<s.entries.length){step++;render();}else{stop();}}
function stop(){clearInterval(timer);timer=null;render();}
$('play').onclick=()=>{if(timer){stop();return;}if(step>=DATA[cur].entries.length)step=0;timer=setInterval(next,1400);next();};
$('next').onclick=()=>{stop();next();};
document.querySelectorAll('.tab[role=tab]').forEach(t=>t.onclick=()=>{stop();cur=+t.dataset.i;step=0;render();});
step=DATA[0].entries.length;render();
</script></body></html>`;
}
