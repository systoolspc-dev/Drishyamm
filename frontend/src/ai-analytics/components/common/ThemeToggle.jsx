import { motion, AnimatePresence } from 'framer-motion'
import { useTheme } from '../../providers/ThemeProvider'

export default function ThemeToggle() {
  const { theme, toggle } = useTheme()
  const isDark = theme === 'dark'

  return (
    <div style={{ position: 'relative' }}>
      <motion.button
        onClick={toggle}
        whileTap={{ scale: 0.88 }}
        title={isDark ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
        style={{
          width: 36, height: 36,
          borderRadius: 8,
          border: '1px solid var(--color-border)',
          background: 'var(--color-surface-high)',
          cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          position: 'relative', overflow: 'hidden',
          transition: 'background 0.2s, border-color 0.2s',
          flexShrink: 0,
        }}
      >
        <AnimatePresence mode="wait" initial={false}>
          {isDark ? (
            <motion.span
              key="moon"
              className="material-symbols-outlined"
              initial={{ opacity: 0, rotate: -30, scale: 0.7 }}
              animate={{ opacity: 1, rotate: 0, scale: 1 }}
              exit={{ opacity: 0, rotate: 30, scale: 0.7 }}
              transition={{ duration: 0.18 }}
              style={{ fontSize: 17, color: '#94a3b8', position: 'absolute' }}
            >
              dark_mode
            </motion.span>
          ) : (
            <motion.span
              key="sun"
              className="material-symbols-outlined"
              initial={{ opacity: 0, rotate: 30, scale: 0.7 }}
              animate={{ opacity: 1, rotate: 0, scale: 1 }}
              exit={{ opacity: 0, rotate: -30, scale: 0.7 }}
              transition={{ duration: 0.18 }}
              style={{ fontSize: 17, color: '#64748b', position: 'absolute' }}
            >
              light_mode
            </motion.span>
          )}
        </AnimatePresence>
      </motion.button>
    </div>
  )
}
