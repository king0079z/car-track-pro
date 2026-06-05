import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { VisitStatusBadge, CameraStatusBadge } from './StatusBadge'

describe('StatusBadge', () => {
  it('renders visit status label', () => {
    render(<VisitStatusBadge status="in_service" />)
    expect(screen.getByText('In Service')).toBeInTheDocument()
  })

  it('renders camera status label', () => {
    render(<CameraStatusBadge status="offline" />)
    expect(screen.getByText('Offline')).toBeInTheDocument()
  })
})
