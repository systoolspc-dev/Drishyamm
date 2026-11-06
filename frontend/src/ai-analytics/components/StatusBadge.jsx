import styles from './StatusBadge.module.css'

const config = {
  // status
  active:           { label: 'Active',           cls: 'green'  },
  suspended:        { label: 'Suspended',         cls: 'red'    },
  online:           { label: 'Online',            cls: 'green'  },
  offline:          { label: 'Offline',           cls: 'red'    },
  // face status
  registered:       { label: 'Registered',        cls: 'green'  },
  pending:          { label: 'Pending',           cls: 'amber'  },
  failed:           { label: 'Failed',            cls: 'red'    },
  removed:          { label: 'Removed',           cls: 'gray'   },
  // event severity
  info:             { label: 'Info',              cls: 'blue'   },
  warning:          { label: 'Warning',           cls: 'amber'  },
  critical:         { label: 'Critical',          cls: 'red'    },
  // ticket status
  open:             { label: 'Open',              cls: 'blue'   },
  in_progress:      { label: 'In Progress',       cls: 'amber'  },
  resolved:         { label: 'Resolved',          cls: 'green'  },
  waiting_customer: { label: 'Waiting',           cls: 'gray'   },
  // ticket priority
  urgent:           { label: 'Urgent',            cls: 'red'    },
  high:             { label: 'High',              cls: 'orange' },
  normal:           { label: 'Normal',            cls: 'blue'   },
  low:              { label: 'Low',               cls: 'gray'   },
  // plan
  Enterprise:       { label: 'Enterprise',        cls: 'orange' },
  Pro:              { label: 'Pro',               cls: 'blue'   },
  Starter:          { label: 'Starter',           cls: 'gray'   },
  // admin role
  superadmin:       { label: 'Superadmin',        cls: 'orange' },
  support:          { label: 'Support',           cls: 'blue'   },
  billing:          { label: 'Billing',           cls: 'green'  },
  readonly:         { label: 'Read-only',         cls: 'gray'   },
}

export default function StatusBadge({ type, dot = true, size = 'sm' }) {
  const c = config[type] || { label: type, cls: 'gray' }
  return (
    <span className={`${styles.badge} ${styles[c.cls]} ${styles[size]}`}>
      {dot && <span className={styles.dot} />}
      {c.label}
    </span>
  )
}