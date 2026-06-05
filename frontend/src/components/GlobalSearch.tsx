import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, Car, Clock, X, Zap } from 'lucide-react';
import { vehiclesApi, visitsApi } from '../services/api';

interface Result {
  type: 'vehicle' | 'visit';
  id: number;
  primary: string;
  secondary: string;
  badge?: string;
  url: string;
}

let searchTimeout: ReturnType<typeof setTimeout>;

export const GlobalSearch: React.FC = () => {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Result[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();

  // Keyboard shortcut Ctrl+K / Cmd+K
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        setOpen(o => !o);
      }
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 50);
      setQ('');
      setResults([]);
      setSelected(0);
    }
  }, [open]);

  const doSearch = useCallback(async (query: string) => {
    if (!query.trim() || query.length < 2) { setResults([]); return; }
    setLoading(true);
    try {
      const [vRes, visitRes] = await Promise.allSettled([
        vehiclesApi.list({ search: query, limit: 5 }),
        visitsApi.list({ plate: query, limit: 5 }),
      ]);

      const out: Result[] = [];

      if (vRes.status === 'fulfilled') {
        (vRes.value.data as any[]).forEach(v => {
          out.push({
            type: 'vehicle',
            id: v.id,
            primary: v.plate_number,
            secondary: `${v.make || ''} ${v.model || ''} ${v.color ? '· ' + v.color : ''}`.trim() || 'Unknown',
            badge: `${v.total_visits} visits`,
            url: `/vehicles/${v.id}`,
          });
        });
      }

      if (visitRes.status === 'fulfilled') {
        (visitRes.value.data as any[]).forEach(v => {
          out.push({
            type: 'visit',
            id: v.id,
            primary: v.visit_number,
            secondary: `${v.vehicle?.plate_number || ''} · ${v.customer_name || 'No customer'}`,
            badge: v.status,
            url: `/visits/${v.id}`,
          });
        });
      }

      setResults(out);
      setSelected(0);
    } finally {
      setLoading(false);
    }
  }, []);

  const handleInput = (val: string) => {
    setQ(val);
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => doSearch(val), 280);
  };

  const go = (url: string) => {
    navigate(url);
    setOpen(false);
    setQ('');
  };

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setSelected(s => Math.min(s + 1, results.length - 1)); }
    if (e.key === 'ArrowUp')   { e.preventDefault(); setSelected(s => Math.max(s - 1, 0)); }
    if (e.key === 'Enter' && results[selected]) go(results[selected].url);
  };

  return (
    <>
      {/* Trigger button */}
      <button
        onClick={() => setOpen(true)}
        style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '7px 14px', borderRadius: 10,
          background: 'var(--bg-elevated)', border: '1px solid var(--border)',
          color: 'var(--text-muted)', cursor: 'pointer', fontSize: 13,
          transition: 'all 0.15s', minWidth: 180,
        }}
        onMouseEnter={e => (e.currentTarget.style.borderColor = 'rgba(59,130,246,0.4)')}
        onMouseLeave={e => (e.currentTarget.style.borderColor = 'var(--border)')}
      >
        <Search size={13} />
        <span>Search...</span>
        <span style={{
          marginLeft: 'auto', fontSize: 10, fontFamily: 'monospace',
          padding: '1px 6px', borderRadius: 4,
          background: 'var(--bg-base)', border: '1px solid var(--border)', color: 'var(--text-muted)',
        }}>Ctrl K</span>
      </button>

      {/* Modal overlay */}
      {open && (
        <div
          style={{
            position: 'fixed', inset: 0, zIndex: 9999,
            background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(6px)',
            display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
            paddingTop: 80,
            animation: 'fadeIn 0.12s ease',
          }}
          onClick={() => setOpen(false)}
        >
          <div
            style={{
              width: '100%', maxWidth: 560,
              background: 'var(--bg-surface)', border: '1px solid var(--border)',
              borderRadius: 16, overflow: 'hidden',
              boxShadow: '0 25px 80px rgba(0,0,0,0.6)',
              animation: 'slideUp 0.15s ease',
            }}
            onClick={e => e.stopPropagation()}
          >
            {/* Search input */}
            <div style={{ display: 'flex', alignItems: 'center', padding: '14px 18px', borderBottom: '1px solid var(--border-light)' }}>
              {loading
                ? <div className="spinner" style={{ width: 16, height: 16, flexShrink: 0 }} />
                : <Search size={16} color="var(--text-muted)" style={{ flexShrink: 0 }} />
              }
              <input
                ref={inputRef}
                value={q}
                onChange={e => handleInput(e.target.value)}
                onKeyDown={handleKey}
                placeholder="Search plate number, visit, customer..."
                style={{
                  flex: 1, padding: '0 12px', background: 'transparent',
                  border: 'none', outline: 'none', color: 'var(--text-primary)',
                  fontSize: 15, fontFamily: 'inherit',
                }}
              />
              <button
                onClick={() => setOpen(false)}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 4 }}
              >
                <X size={16} />
              </button>
            </div>

            {/* Results */}
            {results.length > 0 && (
              <div style={{ maxHeight: 360, overflowY: 'auto' }}>
                {results.map((r, i) => (
                  <button
                    key={`${r.type}-${r.id}`}
                    onClick={() => go(r.url)}
                    style={{
                      width: '100%', display: 'flex', alignItems: 'center', gap: 12,
                      padding: '12px 18px', border: 'none', textAlign: 'left',
                      background: i === selected ? 'var(--bg-hover)' : 'transparent',
                      cursor: 'pointer', transition: 'background 0.1s', borderBottom: '1px solid var(--border-light)',
                    }}
                    onMouseEnter={() => setSelected(i)}
                  >
                    <div style={{
                      width: 32, height: 32, borderRadius: 8, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
                      background: r.type === 'vehicle' ? 'var(--blue-dim)' : 'var(--purple-dim)',
                    }}>
                      {r.type === 'vehicle' ? <Car size={14} color="var(--text-accent)" /> : <Clock size={14} color="var(--text-purple)" />}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)', fontFamily: r.type === 'vehicle' ? 'monospace' : 'inherit' }}>
                        {r.primary}
                      </div>
                      <div style={{ fontSize: 11.5, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {r.secondary}
                      </div>
                    </div>
                    {r.badge && (
                      <span style={{
                        fontSize: 10, padding: '2px 8px', borderRadius: 99, flexShrink: 0,
                        background: 'var(--bg-elevated)', border: '1px solid var(--border)',
                        color: 'var(--text-muted)', textTransform: 'capitalize',
                      }}>
                        {r.badge}
                      </span>
                    )}
                    <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{r.type === 'vehicle' ? 'vehicle' : 'visit'}</span>
                  </button>
                ))}
              </div>
            )}

            {/* Empty */}
            {q.length >= 2 && !loading && results.length === 0 && (
              <div style={{ padding: '28px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
                No results for "{q}"
              </div>
            )}

            {/* Tips */}
            {q.length < 2 && (
              <div style={{ padding: '16px 18px', display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                {[
                  { icon: Car, tip: 'Search plate number' },
                  { icon: Clock, tip: 'Search visit number' },
                  { icon: Zap, tip: 'Search customer name' },
                ].map(({ icon: Icon, tip }) => (
                  <div key={tip} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: 'var(--text-muted)' }}>
                    <Icon size={11} /> {tip}
                  </div>
                ))}
              </div>
            )}

            {/* Footer */}
            <div style={{ padding: '8px 18px 12px', display: 'flex', gap: 14, fontSize: 10.5, color: 'var(--text-muted)', borderTop: '1px solid var(--border-light)' }}>
              <span><kbd style={{ padding: '1px 5px', borderRadius: 3, border: '1px solid var(--border)', fontSize: 10 }}>↑↓</kbd> navigate</span>
              <span><kbd style={{ padding: '1px 5px', borderRadius: 3, border: '1px solid var(--border)', fontSize: 10 }}>↵</kbd> open</span>
              <span><kbd style={{ padding: '1px 5px', borderRadius: 3, border: '1px solid var(--border)', fontSize: 10 }}>Esc</kbd> close</span>
            </div>
          </div>
        </div>
      )}
    </>
  );
};
