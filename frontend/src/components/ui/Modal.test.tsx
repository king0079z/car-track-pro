import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Modal } from './Modal'

describe('Modal', () => {
  const onClose = vi.fn()

  beforeEach(() => {
    onClose.mockClear()
  })

  it('returns null when closed', () => {
    const { container } = render(
      <Modal isOpen={false} onClose={onClose} title="T">
        <p>Body</p>
      </Modal>,
    )
    expect(container.firstChild).toBeNull()
  })

  it('renders title and children when open', () => {
    render(
      <Modal isOpen onClose={onClose} title="Hello">
        <p>Content</p>
      </Modal>,
    )
    expect(screen.getByText('Hello')).toBeInTheDocument()
    expect(screen.getByText('Content')).toBeInTheDocument()
  })

  it('calls onClose when Escape is pressed', async () => {
    render(
      <Modal isOpen onClose={onClose} title="T">
        x
      </Modal>,
    )
    await userEvent.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalled()
  })
})
