import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, X, Edit, Trash2, Shield, User as UserIcon, Search } from 'lucide-react';
import { usersApi } from '../../services/api';
import { fmtQatar } from '../../lib/qatarTime';
import toast from 'react-hot-toast';
import type { User } from '../../types';
import { useAuth } from '../../contexts/AuthContext';

const ROLE_CFG: Record<string, { color: string; bg: string; icon: string }> = {
  admin:   { color: 'var(--text-danger)', bg: 'var(--red-dim)',     icon: '👑' },
  manager: { color: 'var(--text-warning)', bg: 'var(--amber-dim)',   icon: '🏅' },
  staff:   { color: 'var(--text-accent)', bg: 'var(--blue-dim)',    icon: '👤' },
  viewer:  { color: '#9ca3af', bg: 'rgba(55,65,81,0.4)', icon: '👁' },
};

const EMPTY_FORM = { full_name: '', email: '', username: '', password: '', role: 'staff', is_active: true };

export const Users: React.FC = () => {
  const qc = useQueryClient();
  const { user: me } = useAuth();
  const [search, setSearch] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [editUser, setEditUser] = useState<User | null>(null);
  const [deleteId, setDeleteId] = useState<number | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);

  const { data: users = [], isLoading } = useQuery({
    queryKey: ['users'],
    queryFn: () => usersApi.list().then(r => r.data),
  });

  const createMutation = useMutation({
    mutationFn: (data: any) => editUser ? usersApi.update(editUser.id, data) : usersApi.create(data),
    onSuccess: () => {
      toast.success(editUser ? 'User updated!' : 'User created!');
      qc.invalidateQueries({ queryKey: ['users'] });
      setShowForm(false); setEditUser(null); setForm(EMPTY_FORM);
    },
    onError: (e: any) => toast.error(e?.response?.data?.detail || 'Failed'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => usersApi.delete(id),
    onSuccess: () => { toast.success('User deleted'); setDeleteId(null); qc.invalidateQueries({ queryKey: ['users'] }); },
    onError: () => toast.error('Delete failed'),
  });

  const openEdit = (user: User) => {
    setEditUser(user);
    setForm({ full_name: user.full_name, email: user.email || '', username: user.username, password: '', role: user.role, is_active: user.is_active });
    setShowForm(true);
  };

  const filtered = (users as User[]).filter(u =>
    !search ||
    u.full_name?.toLowerCase().includes(search.toLowerCase()) ||
    u.username?.toLowerCase().includes(search.toLowerCase()) ||
    u.email?.toLowerCase().includes(search.toLowerCase())
  );

  const inputStyle = {
    width: '100%', padding: '9px 14px',
    background: 'var(--input-bg)', border: '1px solid var(--border)',
    borderRadius: 10, color: 'var(--text-primary)',
    fontSize: 13.5, fontFamily: 'inherit', outline: 'none',
  };

  return (
    <div className="animate-fade-in">
      <div className="page-header">
        <div>
          <h1 className="page-title">Users</h1>
          <p className="page-desc">{(users as User[]).length} team members</p>
        </div>
        <button className="btn btn-primary" onClick={() => { setEditUser(null); setForm(EMPTY_FORM); setShowForm(true); }}>
          <Plus size={15} /> Add User
        </button>
      </div>

      {/* Search */}
      <div className="filter-bar">
        <div className="search-wrap">
          <Search size={14} />
          <input className="input search-input" placeholder="Search users..." value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        {search && <button className="btn btn-ghost btn-sm" onClick={() => setSearch('')}><X size={12} /></button>}
      </div>

      {/* Role Summary */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 20 }}>
        {Object.entries(ROLE_CFG).map(([role, cfg]) => {
          const count = (users as User[]).filter(u => u.role === role).length;
          return (
            <div key={role} style={{
              padding: '8px 16px', borderRadius: 10, fontSize: 13,
              background: count > 0 ? cfg.bg : 'var(--bg-elevated)',
              border: `1px solid ${count > 0 ? `${cfg.color}30` : 'var(--border)'}`,
              color: count > 0 ? cfg.color : 'var(--text-muted)',
              fontWeight: 600, display: 'flex', alignItems: 'center', gap: 7,
            }}>
              <span>{cfg.icon}</span>
              <span style={{ textTransform: 'capitalize' }}>{role}</span>
              <span style={{ opacity: 0.7, fontWeight: 400 }}>({count})</span>
            </div>
          );
        })}
      </div>

      {/* Users Table */}
      <div className="card" style={{ overflow: 'hidden' }}>
        {isLoading ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: 48 }}>
            <div className="spinner" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="empty-state">
            <UserIcon size={40} />
            <h3>No users found</h3>
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>User</th>
                  <th>Username</th>
                  <th>Email</th>
                  <th>Role</th>
                  <th>Status</th>
                  <th>Joined</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((user: User) => {
                  const roleCfg = ROLE_CFG[user.role] || ROLE_CFG.viewer;
                      const initials = user.full_name?.split(' ').map((w: string) => w[0]).join('').slice(0, 2).toUpperCase();
                  const isMe = user.id === me?.id;

                  return (
                    <tr key={user.id}>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          <div style={{
                            width: 36, height: 36, borderRadius: 10, flexShrink: 0,
                            background: `linear-gradient(135deg, ${roleCfg.color}40, ${roleCfg.color}20)`,
                            border: `1px solid ${roleCfg.color}30`,
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            fontSize: 13, fontWeight: 800, color: roleCfg.color,
                          }}>
                            {initials}
                          </div>
                          <div>
                            <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>
                              {user.full_name}
                              {isMe && <span style={{ fontSize: 10, color: '#10b981', marginLeft: 7, fontWeight: 600 }}>you</span>}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td style={{ fontFamily: 'monospace', fontSize: 12.5, color: 'var(--text-secondary)' }}>
                        @{user.username}
                      </td>
                      <td style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
                        {user.email || <span style={{ color: 'var(--text-muted)' }}>—</span>}
                      </td>
                      <td>
                        <span style={{
                          display: 'inline-flex', alignItems: 'center', gap: 5,
                          padding: '3px 10px', borderRadius: 99, fontSize: 11.5, fontWeight: 600,
                          background: roleCfg.bg, color: roleCfg.color,
                        }}>
                          {roleCfg.icon} <span style={{ textTransform: 'capitalize' }}>{user.role}</span>
                        </span>
                      </td>
                      <td>
                        <span style={{
                          display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11.5, fontWeight: 600,
                          padding: '3px 10px', borderRadius: 99,
                          background: user.is_active ? 'var(--emerald-dim)' : 'rgba(55,65,81,0.4)',
                          color: user.is_active ? 'var(--text-success)' : '#9ca3af',
                        }}>
                          {user.is_active ? '● Active' : '○ Inactive'}
                        </span>
                      </td>
                      <td style={{ fontSize: 12, color: 'var(--text-muted)', fontFamily: 'monospace' }}>
                        {user.created_at ? fmtQatar(user.created_at, 'medDate') : '—'}
                      </td>
                      <td>
                        <div style={{ display: 'flex', gap: 4 }}>
                          <button className="btn btn-ghost btn-icon" onClick={() => openEdit(user)} title="Edit">
                            <Edit size={13} />
                          </button>
                          {!isMe && (
                            <button className="btn btn-danger btn-icon" onClick={() => setDeleteId(user.id)} title="Delete">
                              <Trash2 size={13} />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Form Modal */}
      {showForm && (
        <div className="modal-backdrop" onClick={() => { setShowForm(false); setEditUser(null); }}>
          <div className="modal-box" style={{ maxWidth: 480 }} onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2 style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)' }}>
                {editUser ? 'Edit User' : 'New User'}
              </h2>
              <button className="btn btn-ghost btn-icon" onClick={() => { setShowForm(false); setEditUser(null); }}><X size={16} /></button>
            </div>
            <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, gridColumn: '1 / -1' }}>
                  <label className="label">Full Name *</label>
                  <input style={inputStyle} value={form.full_name} onChange={e => setForm(f => ({ ...f, full_name: e.target.value }))} />
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <label className="label">Username *</label>
                  <input style={inputStyle} value={form.username} onChange={e => setForm(f => ({ ...f, username: e.target.value }))} />
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <label className="label">Email</label>
                  <input type="email" style={inputStyle} value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} />
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <label className="label">{editUser ? 'New Password' : 'Password *'}</label>
                  <input type="password" style={inputStyle} value={form.password}
                    onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
                    placeholder={editUser ? 'Leave blank to keep' : ''} />
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <label className="label">Role</label>
                  <select style={inputStyle} value={form.role} onChange={e => setForm(f => ({ ...f, role: e.target.value }))}>
                    {Object.entries(ROLE_CFG).map(([k, v]) => (
                      <option key={k} value={k}>{v.icon} {k.charAt(0).toUpperCase() + k.slice(1)}</option>
                    ))}
                  </select>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <label className="label">Status</label>
                  <select style={inputStyle} value={form.is_active ? 'active' : 'inactive'} onChange={e => setForm(f => ({ ...f, is_active: e.target.value === 'active' }))}>
                    <option value="active">Active</option>
                    <option value="inactive">Inactive</option>
                  </select>
                </div>
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => { setShowForm(false); setEditUser(null); }}>Cancel</button>
              <button
                className="btn btn-primary"
                onClick={() => {
                  const data: any = { ...form };
                  if (editUser && !data.password) delete data.password;
                  createMutation.mutate(data);
                }}
                disabled={!form.full_name || !form.username || (!editUser && !form.password) || createMutation.isPending}
              >
                {createMutation.isPending ? <><div className="spinner" style={{ width: 14, height: 14 }} /> Saving...</> : editUser ? 'Update User' : 'Create User'}
              </button>
            </div>
          </div>
        </div>
      )}

      {deleteId !== null && (
        <div className="modal-backdrop" onClick={() => setDeleteId(null)}>
          <div className="modal-box" style={{ maxWidth: 380 }} onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2 style={{ fontSize: 16, fontWeight: 700 }}>Delete User?</h2>
              <button className="btn btn-ghost btn-icon" onClick={() => setDeleteId(null)}><X size={16} /></button>
            </div>
            <div className="modal-body">
              <p style={{ color: 'var(--text-secondary)', fontSize: 14 }}>This will permanently delete the user account.</p>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setDeleteId(null)}>Cancel</button>
              <button className="btn btn-danger" onClick={() => deleteId && deleteMutation.mutate(deleteId)} disabled={deleteMutation.isPending}>
                <Trash2 size={13} /> Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
