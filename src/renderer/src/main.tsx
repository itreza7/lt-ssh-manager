import { createRoot } from 'react-dom/client'
import '@fontsource-variable/hanken-grotesk'
import '@fontsource-variable/jetbrains-mono'
import '@fontsource-variable/fira-code'
import App from './App'
import './index.css'

// No StrictMode: its double-invoked effects would open two SSH sessions per tab.
createRoot(document.getElementById('root')!).render(<App />)
