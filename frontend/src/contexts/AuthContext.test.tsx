import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { AuthProvider, useAuth } from './AuthContext'
import * as api from '../services/api'

vi.mock('../services/api', async () => {
  const actual = await vi.importActual<typeof import('../services/api')>('../services/api')
  return {
    ...actual,
    authApi: {
      ...actual.authApi,
      login: vi.fn(),
    },
  }
})

const staffUser = {
  id: 2,
  full_name: 'Staff User',
  email: 'staff@example.com',
  username: 'staffuser',
  role: 'staff' as const,
  is_active: true,
  created_at: '2024-01-01T00:00:00',
}

function AuthFlags() {
  const { isAuthenticated, user } = useAuth()
  return (
    <div>
      <span data-testid="auth">{isAuthenticated ? 'yes' : 'no'}</span>
      <span data-testid="role">{user?.role ?? ''}</span>
    </div>
  )
}

function AuthOnlyFlag() {
  const { isAuthenticated } = useAuth()
  return <span data-testid="auth">{isAuthenticated ? 'yes' : 'no'}</span>
}

function LoginButton() {
  const { login, isAuthenticated, user } = useAuth()
  return (
    <div>
      <button type="button" onClick={() => void login('staffuser', 'pw')}>
        go
      </button>
      <span data-testid="auth">{isAuthenticated ? 'yes' : 'no'}</span>
      <span data-testid="user">{user?.username ?? ''}</span>
    </div>
  )
}

function renderAuth(ui: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}

describe('AuthProvider', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.mocked(api.authApi.login).mockReset()
  })

  it('restores session from localStorage when token is valid', async () => {
    const exp = Math.floor(Date.now() / 1000) + 3600
    const payload = btoa(JSON.stringify({ exp }))
    const token = `h.${payload}.sig`
    localStorage.setItem('cartrack_token', token)
    localStorage.setItem('cartrack_user', JSON.stringify(staffUser))

    renderAuth(
      <AuthProvider>
        <AuthFlags />
      </AuthProvider>,
    )

    await waitFor(() => {
      expect(screen.getByTestId('auth').textContent).toBe('yes')
    })
    expect(screen.getByTestId('role').textContent).toBe('staff')
  })

  it('clears expired token from localStorage on mount', async () => {
    const exp = Math.floor(Date.now() / 1000) - 60
    const payload = btoa(JSON.stringify({ exp }))
    const token = `h.${payload}.sig`
    localStorage.setItem('cartrack_token', token)
    localStorage.setItem('cartrack_user', JSON.stringify(staffUser))

    renderAuth(
      <AuthProvider>
        <AuthOnlyFlag />
      </AuthProvider>,
    )

    await waitFor(() => {
      expect(screen.getByTestId('auth').textContent).toBe('no')
    })
    expect(localStorage.getItem('cartrack_token')).toBeNull()
  })

  it('login stores token and user', async () => {
    vi.mocked(api.authApi.login).mockResolvedValue({
      data: {
        access_token: 'new-token',
        user: staffUser,
      },
    } as never)

    renderAuth(
      <AuthProvider>
        <LoginButton />
      </AuthProvider>,
    )

    await userEvent.click(screen.getByRole('button', { name: 'go' }))
    await waitFor(() => {
      expect(screen.getByTestId('auth').textContent).toBe('yes')
    })
    expect(screen.getByTestId('user').textContent).toBe('staffuser')
    expect(localStorage.getItem('cartrack_token')).toBe('new-token')
  })
})
