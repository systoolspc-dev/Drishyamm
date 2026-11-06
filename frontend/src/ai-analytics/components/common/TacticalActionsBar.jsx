import { useState } from 'react'
import { useNavigate } from 'react-router-dom'

export default function TacticalActionsBar({ label = 'TACTICAL ACTIONS', icon = 'shield', actions = [] }) {
  const navigate = useNavigate()
  const [collapsed, setCollapsed] = useState(false)
  const visibleActions = actions.filter(action => !action.hidden)

  const handleAction = (action) => {
    if (action.disabled) return
    if (action.onClick) {
      action.onClick()
      return
    }
    if (action.to) navigate(action.to)
  }

  return (
    <div
      className={`weapon-actions-bar ${collapsed ? 'is-collapsed' : ''}`}
    >
      <div className="weapon-actions-bar-label">
        <span className="material-symbols-outlined">{icon}</span>
        {label}
      </div>
      <button
        className="weapon-actions-collapse"
        type="button"
        onClick={() => setCollapsed(prev => !prev)}
        aria-label={collapsed ? `Show ${label.toLowerCase()}` : `Hide ${label.toLowerCase()}`}
        title={collapsed ? 'Show actions' : 'Hide actions'}
      >
        <span className="material-symbols-outlined">{collapsed ? 'keyboard_arrow_up' : 'keyboard_arrow_down'}</span>
      </button>
      <div className="weapon-actions-bar-buttons">
        {visibleActions.map(action => (
          <button
            className={`weapon-action-btn ${action.tone || ''}`}
            key={action.label}
            title={action.title || action.label}
            aria-label={action.ariaLabel || action.label}
            type="button"
            onClick={() => handleAction(action)}
            disabled={!!action.disabled}
          >
            <span className="material-symbols-outlined">{action.icon}</span>
            <span className="weapon-action-label">{action.label}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
