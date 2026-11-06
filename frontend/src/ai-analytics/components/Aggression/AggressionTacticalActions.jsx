import TacticalActionsBar from '../common/TacticalActionsBar.jsx'

const ACTIONS = [
  { label: 'Dispatch Security', icon: 'local_police',   tone: 'danger' },
  { label: 'Open Camera Trail', icon: 'route',          tone: ''       },
  { label: 'Open GIS Map',      icon: 'map',            tone: ''       },
  { label: 'Open Live Feed',    icon: 'monitor',        tone: ''       },
  { label: 'Lockdown Zone',     icon: 'lock',           tone: ''       },
  { label: 'Create Report',     icon: 'summarize',      tone: ''       },
]

export default function AggressionTacticalActions() {
  return <TacticalActionsBar label="AGGRESSION RESPONSE" icon="front_hand" actions={ACTIONS} />
}
