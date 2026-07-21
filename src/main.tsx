import React from 'react'
import ReactDOM from 'react-dom/client'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/500.css'
import '@fontsource/jetbrains-mono/700.css'
import '@fontsource/space-grotesk/500.css'
import '@fontsource/space-grotesk/700.css'
import './index.css'
import HomeApp from './home/HomeApp'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <HomeApp />
  </React.StrictMode>,
)
