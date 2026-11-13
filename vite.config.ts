import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'
import { defineConfig } from 'vite'

export default defineConfig({
  base: process.env.VITE_BASE_PATH || '/',
  plugins: [react(), tailwindcss(), VitePWA({
    registerType: 'autoUpdate',
    workbox: {
      navigateFallbackDenylist: [/^\/api(?:\/|$)/],
    },
    manifest: {
      name: 'Meet-up Planner',
      short_name: 'Meet-up Planner',
      description: 'A little time for your people.',
      theme_color: '#f8f7f3',
      background_color: '#f8f7f3',
      display: 'standalone',
      start_url: '.',
      icons: [
        { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
      ],
    },
  })],
})
