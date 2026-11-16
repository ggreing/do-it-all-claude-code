<script setup lang="ts">
// One role's editor: locked fields are shown read-only with the daemon's reason; the editable fields
// (tools, model, effort, maxTurns, description, verify, body) post a partial to /dashboard/settings/role.
// A refused write (per-field errors) shows inline and saves nothing. Conditional verify steps (objects)
// can't be expressed in the line editor, so the whole-file editor is offered for them.
import { reactive, ref, computed } from 'vue';
import { settingsApi, SettingsError, type RoleItem, type FieldError } from '../settings';
import { ApiError } from '../api';
import { t } from '../i18n';

// `canWrite` is false after a reload with only the session cookie (no CSRF token): the fields stay visible
// and editable, but every Save/Revert is disabled (M4). The parent shows the note on how to get it back.
const props = defineProps<{ item: RoleItem; canWrite?: boolean }>();
const emit = defineEmits<{ saved: [] }>();

const SCALARS = ['model', 'effort', 'maxTurns', 'description'] as const;

const field = (k: string) => props.item.fields[k];
const verifyRaw = computed(() => (Array.isArray(field('x-router.verify')?.value) ? (field('x-router.verify')!.value as unknown[]) : []));
const verifyAllStrings = computed(() => verifyRaw.value.every(v => typeof v === 'string'));

function initEdit(): Record<string, string> {
  const e: Record<string, string> = {};
  for (const k of SCALARS) { const f = field(k); if (f?.editable) e[k] = f.value == null ? '' : String(f.value); }
  const tools = field('tools');
  if (tools?.editable) e.tools = Array.isArray(tools.value) ? (tools.value as string[]).join(', ') : String(tools.value ?? '');
  if (field('x-router.verify')?.editable && verifyAllStrings.value) e.verify = (verifyRaw.value as string[]).join('\n');
  if (field('body')?.editable) e.body = String(field('body')?.value ?? '');
  return e;
}
const edit = reactive(initEdit());
const rawMode = ref(false);
const rawText = ref(props.item.text);

const saving = ref(false);
const saved = ref(false);
const errors = ref<FieldError[]>([]);
const topError = ref<string | null>(null);

const lockedFields = computed(() => Object.entries(props.item.fields).filter(([, f]) => f.locked));
const errsFor = (path: string): FieldError[] =>
  errors.value.filter(e => e.path === path || e.path.startsWith(`${path}[`) || e.path.startsWith(`${path}.`));
const unmatched = computed(() => errors.value.filter(e =>
  !['tools', 'model', 'effort', 'maxTurns', 'description', 'body', 'x-router.verify'].some(k => e.path === k || e.path.startsWith(`${k}[`) || e.path.startsWith(`${k}.`))));

function reset(): void { errors.value = []; topError.value = null; saved.value = false; }
function onError(e: unknown): void {
  if (e instanceof SettingsError) {
    if (e.status === 409) topError.value = t('set.errConflict');
    else if (e.status === 403) topError.value = t('set.errForbidden');
    errors.value = e.errors;
  } else if (e instanceof ApiError) {
    topError.value = e.kind === 'unauthorized' ? t('banner.unauthorized') : e.kind === 'timeout' ? t('banner.timeout') : t('banner.daemonOff');
  } else topError.value = t('banner.httpError');
}

async function save(): Promise<void> {
  reset(); saving.value = true;
  try {
    const fields: Record<string, unknown> = {};
    for (const k of SCALARS) if (k in edit) fields[k] = k === 'maxTurns' ? Number(edit[k]) : edit[k];
    if ('tools' in edit) fields.tools = edit.tools.split(',').map(s => s.trim()).filter(Boolean);
    if ('verify' in edit) fields['x-router.verify'] = edit.verify.split('\n').map(s => s.trim()).filter(Boolean);
    if ('body' in edit) fields.body = edit.body;
    await settingsApi.writeRole({ role: props.item.role, fields, revision: props.item.revision });
    saved.value = true; emit('saved');
  } catch (e) { onError(e); } finally { saving.value = false; }
}
async function saveRaw(): Promise<void> {
  reset(); saving.value = true;
  try { await settingsApi.writeRole({ role: props.item.role, text: rawText.value, revision: props.item.revision }); saved.value = true; emit('saved'); }
  catch (e) { onError(e); } finally { saving.value = false; }
}
async function revert(): Promise<void> {
  reset(); saving.value = true;
  try { await settingsApi.writeRole({ role: props.item.role, reset: true }); saved.value = true; emit('saved'); }
  catch (e) { onError(e); } finally { saving.value = false; }
}
</script>

<template>
  <div class="panel role">
    <div class="row" style="justify-content: space-between;">
      <strong>{{ item.role }}
        <span v-if="item.overridden" class="badge" :title="item.overriddenFields.join(', ')">{{ t('set.overridden') }}</span>
      </strong>
      <div class="row">
        <button class="ghost" @click="rawMode = !rawMode">{{ rawMode ? t('set.fBody') : '.md' }}</button>
        <button class="ghost" v-if="item.overridden" @click="revert" :disabled="saving || canWrite === false">{{ t('set.revertTemplate') }}</button>
      </div>
    </div>

    <p v-if="topError" class="err" role="alert">{{ topError }}</p>
    <p v-else-if="errors.length" class="err" role="alert">{{ t('set.fixErrors') }}</p>
    <ul v-if="unmatched.length" class="err">
      <li v-for="(e, i) in unmatched" :key="i"><code class="mono">{{ e.path || '—' }}</code> {{ e.message }}</li>
    </ul>

    <!-- raw .md editor: full fidelity, needed for conditional verify steps -->
    <template v-if="rawMode">
      <textarea v-model="rawText" rows="16" class="mono" spellcheck="false"></textarea>
      <div class="row" style="margin-top: 8px;">
        <button class="ghost" @click="saveRaw" :disabled="saving || canWrite === false">{{ saving ? t('set.saving') : t('set.save') }}</button>
        <span v-if="saved" class="badge ok">{{ t('set.saved') }}</span>
      </div>
    </template>

    <template v-else>
      <div class="fields">
        <label class="f"><span>{{ t('set.fModel') }}</span>
          <input v-model="edit.model" :list="`m-${item.role}`" />
          <datalist :id="`m-${item.role}`"><option v-for="o in field('model')?.options ?? []" :key="o" :value="o" /></datalist>
          <small class="muted" v-if="field('model')?.rule">{{ field('model')?.rule }}</small>
          <small class="err" v-for="(e, i) in errsFor('model')" :key="i">{{ e.message }}</small>
        </label>
        <label class="f"><span>{{ t('set.fEffort') }}</span>
          <select v-model="edit.effort"><option v-for="o in field('effort')?.options ?? []" :key="o" :value="o">{{ o }}</option></select>
          <small class="err" v-for="(e, i) in errsFor('effort')" :key="i">{{ e.message }}</small>
        </label>
        <label class="f"><span>{{ t('set.fMaxTurns') }}</span>
          <input type="number" v-model="edit.maxTurns" :min="field('maxTurns')?.min" :max="field('maxTurns')?.max" />
          <small class="err" v-for="(e, i) in errsFor('maxTurns')" :key="i">{{ e.message }}</small>
        </label>
        <label class="f wide"><span>{{ t('set.fDescription') }}</span>
          <input v-model="edit.description" />
          <small class="err" v-for="(e, i) in errsFor('description')" :key="i">{{ e.message }}</small>
        </label>
        <label class="f wide"><span>{{ t('set.fTools') }} <small class="muted">· {{ t('set.toolsHint') }}</small></span>
          <input v-model="edit.tools" />
          <small class="muted" v-if="field('tools')?.rule">{{ field('tools')?.rule }}</small>
          <small class="err" v-for="(e, i) in errsFor('tools')" :key="i">{{ e.message }}</small>
        </label>
      </div>

      <div class="f wide" style="margin-top: 10px;">
        <span>{{ t('set.fVerify') }} <small class="muted">· {{ t('set.verifyHint') }}</small></span>
        <textarea v-if="verifyAllStrings" v-model="edit.verify" rows="3" class="mono" spellcheck="false"></textarea>
        <ul v-else class="muted mono readonly">
          <li v-for="(v, i) in verifyRaw" :key="i">{{ typeof v === 'string' ? v : ((v as { command?: string }).command ?? JSON.stringify(v)) }}</li>
        </ul>
        <small class="muted" v-if="!verifyAllStrings">{{ '.md' }} — {{ t('set.verifyHint') }}</small>
        <small class="warn-note" v-if="field('x-router.verify')?.runsAsYou">⚠ {{ t('set.runsAsYou') }}</small>
        <small class="err" v-for="(e, i) in errsFor('x-router.verify')" :key="i">{{ e.message }}</small>
      </div>

      <div class="f wide" style="margin-top: 10px;">
        <span>{{ t('set.fBody') }}</span>
        <textarea v-model="edit.body" rows="8" class="mono" spellcheck="false"></textarea>
        <small class="err" v-for="(e, i) in errsFor('body')" :key="i">{{ e.message }}</small>
      </div>

      <div class="row" style="margin-top: 10px;">
        <button class="ghost" @click="save" :disabled="saving || canWrite === false">{{ saving ? t('set.saving') : t('set.save') }}</button>
        <span v-if="saved" class="badge ok">{{ t('set.saved') }}</span>
      </div>
    </template>

    <details class="locked" v-if="lockedFields.length">
      <summary class="muted">{{ t('set.locked') }} ({{ lockedFields.length }})</summary>
      <div v-for="[k, f] in lockedFields" :key="k" class="lockrow">
        <code class="mono">{{ k }}</code>
        <span class="mono val">{{ Array.isArray(f.value) ? (f.value as string[]).join(', ') : String(f.value) }}</span>
        <span class="badge">{{ t('set.locked') }}</span>
        <small class="muted" v-if="f.reason">{{ f.reason }}</small>
      </div>
    </details>
  </div>
</template>

<style scoped>
.role { margin-bottom: 12px; }
.fields { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 10px; margin-top: 10px; }
.f { display: flex; flex-direction: column; gap: 4px; }
.f.wide { grid-column: 1 / -1; }
.f > span { font-size: 12px; color: var(--muted); }
.f input, .f select, textarea { font: inherit; background: var(--panel-2); color: var(--ink); border: 1px solid var(--line); border-radius: 8px; padding: 6px 8px; width: 100%; }
textarea { resize: vertical; }
small { font-size: 11px; }
.err { color: var(--bad); }
.warn-note { color: var(--warn); }
ul.readonly { list-style: none; padding: 6px 8px; margin: 0; background: var(--panel-2); border: 1px solid var(--line); border-radius: 8px; }
.locked { margin-top: 10px; }
.lockrow { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; padding: 4px 0; }
.lockrow .val { color: var(--muted); }
</style>
