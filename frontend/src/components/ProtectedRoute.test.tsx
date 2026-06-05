import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { ProtectedRoute } from './ProtectedRoute'
import { useAuth } from '../contexts/AuthContext'

vi.mock('../contexts/AuthContext', () => ({
  useAuth: vi.fn(),
}))

const mockUseAuth = vi.mocked(useAuth)

const baseUser = {
  id: 1,
  full_name: 'Test',
  email: 't@test.com',
  username: 't',
  is_active: true,
  created_at: '2024-01-01T00:00:00',
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('ProtectedRoute', () => {
  it('shows loader while auth is loading', () => {
    mockUseAuth.mockReturnValue({
      isAuthenticated: false,
      user: null,
      token: null,
      isLoading: true,
      login: vi.fn(),
      logout: vi.fn(),
    })

    render(
      <MemoryRouter>
        <ProtectedRoute>
          <div>Inside</div>
        </ProtectedRoute>
      </MemoryRouter>,
    )
    expect(screen.getByText('Loading...')).toBeInTheDocument()
    expect(screen.queryByText('Inside')).not.toBeInTheDocument()
  })

  it('redirects unauthenticated user to login', () => {
    mockUseAuth.mockReturnValue({
      isAuthenticated: false,
      user: null,
      token: null,
      isLoading: false,
      login: vi.fn(),
      logout: vi.fn(),
    })

    render(
      <MemoryRouter initialEntries={['/secret']}>
        <Routes>
          <Route
            path="/secret"
            element={
              <ProtectedRoute>
                <div>Secret</div>
              </ProtectedRoute>
            }
          />
          <Route path="/login" element={<div data-testid="login">Login</div>} />
        </Routes>
      </MemoryRouter>,
    )
    expect(screen.getByTestId('login')).toBeInTheDocument()
  })

  it('allows manager for adminOnly', () => {
    mockUseAuth.mockReturnValue({
      isAuthenticated: true,
      user: { ...baseUser, role: 'manager' },
      token: 't',
      isLoading: false,
      login: vi.fn(),
      logout: vi.fn(),
    })

    render(
      <MemoryRouter initialEntries={['/x']}>
        <Routes>
          <Route
            path="/x"
            element={
              <ProtectedRoute adminOnly>
                <div>AdminArea</div>
              </ProtectedRoute>
            }
          />
        </Routes>
      </MemoryRouter>,
    )
    expect(screen.getByText('AdminArea')).toBeInTheDocument()
  })

  it('redirects staff away from adminOnly to home', () => {
    mockUseAuth.mockReturnValue({
      isAuthenticated: true,
      user: { ...baseUser, role: 'staff' },
      token: 't',
      isLoading: false,
      login: vi.fn(),
      logout: vi.fn(),
    })

    render(
      <MemoryRouter initialEntries={['/x']}>
        <Routes>
          <Route
            path="/x"
            element={
              <ProtectedRoute adminOnly>
                <div>Secret</div>
              </ProtectedRoute>
            }
          />
          <Route path="/" element={<div data-testid="home">Home</div>} />
        </Routes>
      </MemoryRouter>,
    )
    expect(screen.queryByText('Secret')).not.toBeInTheDocument()
    expect(screen.getByTestId('home')).toBeInTheDocument()
  })

  it('redirects manager away from adminRoleOnly', () => {
    mockUseAuth.mockReturnValue({
      isAuthenticated: true,
      user: { ...baseUser, role: 'manager' },
      token: 't',
      isLoading: false,
      login: vi.fn(),
      logout: vi.fn(),
    })

    render(
      <MemoryRouter initialEntries={['/settings']}>
        <Routes>
          <Route
            path="/settings"
            element={
              <ProtectedRoute adminRoleOnly>
                <div>Settings</div>
              </ProtectedRoute>
            }
          />
          <Route path="/" element={<div data-testid="home">Home</div>} />
        </Routes>
      </MemoryRouter>,
    )
    expect(screen.getByTestId('home')).toBeInTheDocument()
  })
})
