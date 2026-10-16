import { App, Modal, Notice } from 'obsidian';
import { render } from 'preact';
import { useEffect, useState } from 'preact/compat';
import { Icon } from 'src/components/Icon/Icon';
import { c } from 'src/components/helpers';

import type { TeamManager } from '../TeamManager';
import { TeamDirectory, TeamProject, TeamRole, TeamUser } from '../types';
import { hueFor, initials } from './TeamBadges';
import { PersonDevices } from './Devices';

const COLORS = ['#5c7cfa', '#20c997', '#f76707', '#e64980', '#7950f2', '#fab005', '#15aabf', '#82c91e', '#fa5252', '#868e96'];

const ROLE_LABEL: Record<TeamRole, string> = { owner: 'Owner', host: 'Host', user: 'User' };

type Person = TeamUser & { projectIds: string[] };

function errorText(e: any) {
  return e?.message || String(e);
}

function copy(text: string) {
  void navigator.clipboard.writeText(text).then(() => new Notice('Copied'));
}

/** Join string shown once after creating a person or issuing a new link. */
function JoinLink({ name, join, onDone }: { name: string; join: string; onDone: () => void }) {
  return (
    <div className={c('mt-join')}>
      <div className={c('mt-join-title')}>
        <Icon name="lucide-key-round" /> Join string for {name}
      </div>
      <div className={c('mt-join-hint')}>
        Send it to {name}. They paste it in Settings → Mad Kanban → Team. It's shown only once.
      </div>
      <div className={c('mt-join-row')}>
        <code className={c('mt-join-code')}>{join}</code>
        <button className="mod-cta" onClick={() => copy(join)}>
          Copy
        </button>
      </div>
      <a className={c('mt-link')} onClick={onDone}>
        Done
      </a>
    </div>
  );
}

function ProjectPills({
  projects,
  selected,
  onToggle,
  disabled,
}: {
  projects: TeamProject[];
  selected: string[];
  onToggle: (id: string, on: boolean) => void;
  disabled?: boolean;
}) {
  if (!projects.length) return <span className={c('mt-muted')}>No projects yet</span>;
  return (
    <div className={c('project-pills')}>
      {projects.map((p) => {
        const on = selected.includes(p.id);
        return (
          <button
            key={p.id}
            type="button"
            disabled={disabled}
            className={`${c('project-pill')} ${on ? 'is-selected' : ''}`}
            style={{ '--project-color': p.color || 'var(--text-muted)' }}
            aria-pressed={on}
            title={on ? `Remove from ${p.name}` : `Add to ${p.name}`}
            onClick={() => onToggle(p.id, !on)}
          >
            <span className={c('project-dot')} />
            {p.name}
          </button>
        );
      })}
    </div>
  );
}

function AddPerson({
  team,
  projects,
  onCreated,
}: {
  team: TeamManager;
  projects: TeamProject[];
  onCreated: (dir: TeamDirectory | null, created: { name: string; join: string }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [role, setRole] = useState<TeamRole>('user');
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  if (!open) {
    return (
      <button className={`mod-cta ${c('mt-add')}`} onClick={() => setOpen(true)}>
        <Icon name="lucide-user-plus" /> Add person
      </button>
    );
  }

  const submit = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      const res = await team.client.createUser(name.trim(), role, picked);
      onCreated(null, { name: res.user.name, join: res.join });
      setOpen(false);
      setName('');
      setRole('user');
      setPicked([]);
    } catch (e) {
      new Notice(`Kanban: ${errorText(e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={c('mt-form')}>
      <div className={c('mt-form-row')}>
        <input
          type="text"
          placeholder="Name"
          value={name}
          ref={(el) => el && !name && el.focus()}
          onInput={(e) => setName((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit();
          }}
        />
        <div className={c('mt-segment')}>
          {(['user', 'host'] as TeamRole[]).map((r) => (
            <button key={r} className={role === r ? 'is-active' : ''} onClick={() => setRole(r)}>
              {ROLE_LABEL[r]}
            </button>
          ))}
        </div>
      </div>
      <div className={c('mt-form-hint')}>
        {role === 'host'
          ? 'Hosts add people and projects, and see cards of the projects they are in.'
          : 'Users see only cards of the projects they are in.'}
      </div>
      <div className={c('mt-form-label')}>Projects</div>
      <ProjectPills
        projects={projects}
        selected={picked}
        onToggle={(id, on) => setPicked(on ? [...picked, id] : picked.filter((x) => x !== id))}
      />
      <div className={c('mt-form-actions')}>
        <button className="mod-cta" disabled={!name.trim() || busy} onClick={() => void submit()}>
          Create
        </button>
        <button onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </div>
  );
}

function PersonRow({
  team,
  person,
  me,
  projects,
  run,
  onJoin,
}: {
  team: TeamManager;
  person: Person;
  me: TeamUser;
  projects: TeamProject[];
  run: (fn: () => Promise<TeamDirectory | void>) => void;
  onJoin: (name: string, join: string) => void;
}) {
  const [confirm, setConfirm] = useState(false);
  const [showDevices, setShowDevices] = useState(false);
  const isMe = person.id === me.id;
  const isOwner = person.role === 'owner';
  const canManage = !isOwner || me.role === 'owner';
  const canRemove = !isMe && !isOwner && (person.role !== 'host' || me.role === 'owner');

  return (
    <div className={c('mt-person')}>
      <div className={c('mt-person-head')}>
        <span className={c('assignee')} style={{ '--assignee-hue': hueFor(person.id) }}>
          {initials(person.name)}
        </span>
        <span className={c('mt-person-name')}>
          {person.name}
          {isMe && <span className={c('mt-muted')}> (you)</span>}
        </span>
        <span className={`${c('mt-role')} is-${person.role || 'user'}`}>{ROLE_LABEL[person.role || 'user']}</span>
        <div className={c('mt-person-actions')}>
          {canManage && (
            <a
              className={`${c('mt-link')} ${showDevices ? 'is-active' : ''}`}
              title="Phones and computers signed in as this person"
              onClick={() => setShowDevices(!showDevices)}
            >
              Devices
            </a>
          )}
          {canManage && !isMe && !isOwner && (
            <a
              className={c('mt-link')}
              onClick={() =>
                run(() => team.client.updateUser(person.id, { role: person.role === 'host' ? 'user' : 'host' }))
              }
            >
              {person.role === 'host' ? 'Make user' : 'Make host'}
            </a>
          )}
          {canManage && !isMe && (
            <a
              className={c('mt-link')}
              title="Issue a new join string; the old one stops working. Devices signed in with their own key stay signed in."
              onClick={() =>
                run(async () => {
                  const res = await team.client.resetUserToken(person.id);
                  onJoin(person.name, res.join);
                })
              }
            >
              New link
            </a>
          )}
          {canRemove &&
            (confirm ? (
              <span className={c('mt-confirm')}>
                Remove {person.name}?
                <a className={`${c('mt-link')} mod-warning`} onClick={() => run(() => team.client.removeUser(person.id))}>
                  Remove
                </a>
                <a className={c('mt-link')} onClick={() => setConfirm(false)}>
                  Cancel
                </a>
              </span>
            ) : (
              <a className={`${c('mt-link')} is-danger`} onClick={() => setConfirm(true)}>
                Remove
              </a>
            ))}
        </div>
      </div>
      {isOwner && me.role !== 'owner' ? (
        <div className={c('mt-muted')}>Sees every project</div>
      ) : (
        <ProjectPills
          projects={projects}
          selected={person.projectIds}
          disabled={!canManage}
          onToggle={(projectId, on) => run(() => team.client.setProjectMember(projectId, person.id, on))}
        />
      )}
      {showDevices && <PersonDevices team={team} userId={person.id} name={person.name} />}
    </div>
  );
}

function ProjectRow({
  team,
  project,
  people,
  run,
}: {
  team: TeamManager;
  project: TeamProject;
  people: Person[];
  run: (fn: () => Promise<TeamDirectory | void>) => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(project.name);
  const members = people.filter((p) => project.memberIds.includes(p.id));
  const cards = project.cardCount || 0;

  const nextColor = () => {
    const i = COLORS.indexOf(project.color);
    return COLORS[(i + 1) % COLORS.length];
  };

  return (
    <div className={c('mt-project')}>
      <button
        className={c('mt-color')}
        style={{ background: project.color || 'var(--text-faint)' }}
        title="Change color"
        onClick={() => run(() => team.client.updateProject(project.id, { color: nextColor() }))}
      />
      {renaming ? (
        <input
          type="text"
          value={name}
          ref={(el) => el?.focus()}
          onInput={(e) => setName((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && name.trim()) {
              setRenaming(false);
              if (name.trim() !== project.name) run(() => team.client.updateProject(project.id, { name: name.trim() }));
            } else if (e.key === 'Escape') {
              e.stopPropagation();
              setName(project.name);
              setRenaming(false);
            }
          }}
          onBlur={() => {
            setRenaming(false);
            setName(project.name);
          }}
        />
      ) : (
        <span className={c('mt-project-name')} title="Click to rename" onClick={() => setRenaming(true)}>
          {project.name}
        </span>
      )}
      <span className={c('mt-project-meta')}>
        {cards} card{cards === 1 ? '' : 's'} · {members.length} {members.length === 1 ? 'person' : 'people'}
      </span>
      <div className={c('mt-project-members')}>
        {members.map((m) => (
          <span
            key={m.id}
            className={c('assignee')}
            style={{ '--assignee-hue': hueFor(m.id) }}
            title={m.name}
          >
            {initials(m.name)}
          </span>
        ))}
      </div>
      <a
        className={`${c('mt-link')} ${cards ? 'is-disabled' : 'is-danger'}`}
        title={cards ? 'Move or delete its cards first' : 'Delete project'}
        onClick={() => {
          if (!cards) run(() => team.client.deleteProject(project.id));
        }}
      >
        Delete
      </a>
    </div>
  );
}

function AddProject({ team, run }: { team: TeamManager; run: (fn: () => Promise<TeamDirectory | void>) => void }) {
  const [name, setName] = useState('');
  const submit = () => {
    if (!name.trim()) return;
    const n = name.trim();
    setName('');
    run(() => team.client.createProject(n));
  };
  return (
    <div className={c('mt-form-row')}>
      <input
        type="text"
        placeholder="New project name"
        value={name}
        onInput={(e) => setName((e.target as HTMLInputElement).value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit();
        }}
      />
      <button className="mod-cta" disabled={!name.trim()} onClick={submit}>
        Add project
      </button>
    </div>
  );
}

function ManageTeam({ team }: { team: TeamManager }) {
  const [dir, setDir] = useState<TeamDirectory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<'people' | 'projects'>('people');
  const [join, setJoin] = useState<{ name: string; join: string } | null>(null);

  const load = async () => {
    try {
      setDir(await team.client.team());
      setError(null);
    } catch (e) {
      setError(errorText(e));
    }
  };

  useEffect(() => {
    void load();
    const fn = () => {
      void load();
    };
    team.emitter.on('team', fn);
    return () => {
      team.emitter.off('team', fn);
    };
  }, []);

  const run = (fn: () => Promise<TeamDirectory | void>) => {
    void fn()
      .then((next) => (next && 'users' in next ? setDir(next) : load()))
      .catch((e) => new Notice(`Kanban: ${errorText(e)}`));
  };

  if (error) return <div className={c('mt-error')}>Could not load the team: {error}</div>;
  if (!dir) return <div className={c('mt-muted')}>Loading…</div>;

  const people = dir.users as Person[];

  return (
    <div className={c('manage-team')}>
      <div className={c('mt-tabs')}>
        <button className={tab === 'people' ? 'is-active' : ''} onClick={() => setTab('people')}>
          <Icon name="lucide-users" /> People <span className={c('mt-count')}>{people.length}</span>
        </button>
        <button className={tab === 'projects' ? 'is-active' : ''} onClick={() => setTab('projects')}>
          <Icon name="lucide-folder" /> Projects <span className={c('mt-count')}>{dir.projects.length}</span>
        </button>
      </div>

      {tab === 'people' ? (
        <div className={c('mt-pane')}>
          {join ? (
            <JoinLink name={join.name} join={join.join} onDone={() => setJoin(null)} />
          ) : (
            <AddPerson
              team={team}
              projects={dir.projects}
              onCreated={(_, created) => {
                setJoin(created);
                void load();
              }}
            />
          )}
          <div className={c('mt-list')}>
            {people.map((p) => (
              <PersonRow
                key={p.id}
                team={team}
                person={p}
                me={dir.me}
                projects={dir.projects}
                run={run}
                onJoin={(name, j) => setJoin({ name, join: j })}
              />
            ))}
          </div>
        </div>
      ) : (
        <div className={c('mt-pane')}>
          <AddProject team={team} run={run} />
          <div className={c('mt-list')}>
            {dir.projects.map((p) => (
              <ProjectRow key={p.id} team={team} project={p} people={people} run={run} />
            ))}
          </div>
          <div className={c('mt-form-hint')}>
            {dir.me.role === 'owner'
              ? 'You see every project. Hosts and users see only the projects they are in.'
              : 'You see the projects you are in. Projects you create include you.'}
          </div>
        </div>
      )}
    </div>
  );
}

export class ManageTeamModal extends Modal {
  team: TeamManager;

  constructor(app: App, team: TeamManager) {
    super(app);
    this.team = team;
  }

  onOpen() {
    this.modalEl.addClass('kanban-plugin__manage-team-modal');
    this.titleEl.setText('Manage team');
    render(<ManageTeam team={this.team} />, this.contentEl);
  }

  onClose() {
    render(null, this.contentEl);
  }
}
