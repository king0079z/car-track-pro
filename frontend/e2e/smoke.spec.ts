import { test, expect } from '@playwright/test'

test.describe('smoke', () => {
  test('login and dashboard load', async ({ page }) => {
    await page.goto('/login')
    await page.getByPlaceholder('Enter password').fill('demo1234')
    await page.getByRole('button', { name: 'Access Dashboard' }).click()
    await expect(page.getByText(/Real-time operations overview/i)).toBeVisible({
      timeout: 30_000,
    })
  })

  test('admin can open Visits and Vehicles', async ({ page }) => {
    await page.goto('/login')
    await page.getByPlaceholder('Enter password').fill('demo1234')
    await page.getByRole('button', { name: 'Access Dashboard' }).click()
    await expect(page.getByText(/Real-time operations overview/i)).toBeVisible({
      timeout: 30_000,
    })

    await page.getByRole('link', { name: 'Visits' }).first().click()
    await expect(page).toHaveURL(/\/visits$/)

    await page.getByRole('link', { name: 'Vehicles' }).first().click()
    await expect(page).toHaveURL(/\/vehicles$/)
  })
})
