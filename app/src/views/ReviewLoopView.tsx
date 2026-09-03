import React, { useMemo, useState } from 'react';
import { useStore } from '../store';

export type ReviewLoopMode = 'ritual';

const HEADINGS: Record<ReviewLoopMode, { eyebrow: string; title: string; copy: string }> = {
  ritual: {
    eyebrow: 'DAILY REVIEW RITUAL',
    title: '把状态、事实和下一步写下来。',
    copy: '日志只记录你的观察与执行，不生成开仓、价格、仓位或杠杆指令。',
  },
};

export default function ReviewLoopView({ mode = 'ritual' }: { mode?: ReviewLoopMode }) {
  const { session, saveJournal, saveGuard, setGuardActive } = useStore();
  const [day, setDay] = useState(() => new Date().toISOString().slice(0, 10));
  const [emotion, setEmotion] = useState('');
  const [note, setNote] = useState('');
  const [guardText, setGuardText] = useState('');
  const [status, setStatus] = useState('');
  const [saving, setSaving] = useState(false);
  const heading = HEADINGS[mode];
  const journal = useMemo(() => [...session.journal]
    .sort((left, right) => right.day.localeCompare(left.day)), [session.journal]);

  async function submitJournal(event: React.FormEvent) {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    try {
      const saved = await saveJournal(day, note, emotion);
      setStatus(saved ? '今日日志已保存' : '日志未保存：草稿已保留，请检查后重试');
      if (saved) {
        setNote('');
        setEmotion('');
      }
    } catch {
      setStatus('日志未保存：草稿已保留，请重试');
    } finally {
      setSaving(false);
    }
  }

  async function submitGuard(event: React.FormEvent) {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    try {
      const saved = await saveGuard(guardText);
      setStatus(saved ? '风控守则已添加' : '守则未保存：输入已保留，请检查后重试');
      if (saved) setGuardText('');
    } catch {
      setStatus('守则未保存：输入已保留，请重试');
    } finally {
      setSaving(false);
    }
  }

  async function toggleGuard(id: string, active: boolean) {
    if (saving) return;
    setSaving(true);
    try {
      const saved = await setGuardActive(id, active);
      setStatus(saved ? `守则已${active ? '启用' : '停用'}` : '守则状态未保存，请重试');
    } catch {
      setStatus('守则状态未保存，请重试');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="page-stack">
      <header className="page-heading">
        <div><p className="eyebrow">{heading.eyebrow}</p><h1>{heading.title}</h1></div>
        <p>{heading.copy}</p>
      </header>

      <section className="two-column review-loop-grid">
        <form className="panel ritual-form" onSubmit={submitJournal}>
          <div className="section-heading compact">
            <div><p className="eyebrow">DAILY LOG</p><h2>今日日志</h2></div>
            <span>{journal.length} 天已记录</span>
          </div>
          <label>日期<input aria-label="日期" type="date" value={day} onChange={(event) => setDay(event.target.value)} /></label>
          <label>今日状态<input aria-label="今日状态" maxLength={80} value={emotion} onChange={(event) => setEmotion(event.target.value)} placeholder="冷静 / 焦虑 / 冲动…" /></label>
          <label>复盘日志<textarea aria-label="复盘日志" maxLength={4_000} value={note} onChange={(event) => setNote(event.target.value)} placeholder="只写事实、偏差和下一次的检查点" /></label>
          <button className="button primary" type="submit" disabled={saving || !day || !note.trim()}>{saving ? '正在保存…' : '保存今日日志'}</button>
        </form>

        <div className="panel guard-panel">
          <div className="section-heading compact">
            <div><p className="eyebrow">PRE-TRADE GUARDS</p><h2>风控守则</h2></div>
            <span>{session.guards.filter((guard) => guard.active).length} 条启用</span>
          </div>
          <form className="guard-form" onSubmit={submitGuard}>
            <label>新增风控守则<input aria-label="新增风控守则" maxLength={600} value={guardText} onChange={(event) => setGuardText(event.target.value)} placeholder="例如：达到日亏损上限后停止" /></label>
            <button className="button secondary" type="submit" disabled={saving || !guardText.trim()}>{saving ? '正在保存…' : '添加守则'}</button>
          </form>
          <ul className="guard-list">
            {session.guards.map((guard) => (
              <li key={guard.id} className={guard.active ? '' : 'guard-disabled'}>
                <span>{guard.active ? '启用' : '停用'}</span>
                <p>{guard.text}</p>
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => { void toggleGuard(guard.id, !guard.active); }}
                  aria-label={`${guard.active ? '停用' : '启用'}守则：${guard.text}`}
                >{guard.active ? '停用' : '启用'}</button>
              </li>
            ))}
          </ul>
          {!session.guards.length && <p className="empty-copy">还没有守则。先写一条可以在开仓前明确核对的限制。</p>}
        </div>
      </section>

      {status && <p className="save-notice" role="status">{status}</p>}

      <section className="panel journal-timeline">
        <div className="section-heading compact">
          <div><p className="eyebrow">HISTORY</p><h2>日志时间线</h2></div>
          <span>只显示主动记录</span>
        </div>
        {journal.map((entry) => (
          <article key={entry.day}>
            <time>{entry.day}</time>
            <strong>{entry.emotion || '未标记状态'}</strong>
            <p>{entry.note}</p>
          </article>
        ))}
        {!journal.length && <p className="empty-copy">尚无日志。</p>}
      </section>
    </div>
  );
}
