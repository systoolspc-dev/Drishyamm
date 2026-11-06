import TacticalActionsBar from '../common/TacticalActionsBar.jsx'

const ACTIONS = [
  { label: 'Track Suspect',  icon: 'my_location',          tone: '' },
  { label: 'Open GIS Map',   icon: 'map',                  tone: '' },
  { label: 'Open Journey',   icon: 'route',                tone: 'danger' },
  { label: 'Face Intake',    icon: 'person_add',           tone: '' },
  { label: 'Build Report',   icon: 'summarize',            tone: '' },
  { label: 'Save Evidence',  icon: 'download',             tone: '' },
]

export default function TacticalActions() {
  return <TacticalActionsBar label="TACTICAL RESPONSE ACTIONS" icon="shield" actions={ACTIONS} />
}
