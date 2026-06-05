import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { GlobalSearch } from './GlobalSearch'

vi.mock('../services/api', () => ({
  vehiclesApi: {
    list: vi.fn().mockResolvedValue({ data: [] }),
  },
  visitsApi: {
    list: vi.fn().mockResolvedValue({ data: [] }),
  },
}))

describe('GlobalSearch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('opens palette from trigger button and shows search input', async () => {
    render(
      <MemoryRouter>
        <GlobalSearch />
      </MemoryRouter>,
    )
    await userEvent.click(screen.getByRole('button', { name: /Search\.\.\./i }))
    expect(
      screen.getByPlaceholderText(/Search plate number/i),
    ).toBeInTheDocument()
  })
})
