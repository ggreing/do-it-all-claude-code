<script setup lang="ts">
// Settings editing (decision 168). Four sub-sections — config, presets, roles, history — on the daemon's
// /dashboard/settings routes. Writes go through the validated core; a refused write shows the daemon's
// per-field errors inline and saves nothing. Managed and locked fields are shown read-only with the reason.
import { onMounted, reactive, ref, watch, computed } from 'vue';
import { settingsApi, SettingsError, getCsrf, type SettingsDoc, type ConfigKey, type FieldError } from '../settings';
import { ApiError } from '../api';
import { useResource } from '../useResource';
import { t, type MessageKey } from '../i18n';
import StateBanner from '../components/StateBanner.vue';
import RoleEditor from '../components/RoleEditor.vue';

type Section = 'config' | 'presets' | 'roles' | 'history';
const sections: Array<{ id: Section; key: MessageKey }> = [
  { id: 'config', key: 'set.config' }, { id: 'presets', key: 'set.presets' },
  { id: 'roles', key: 'set.roles' }, { id: 'history', key: 'set.history' },
];
const section = ref<Section>('config');
const showAdvanced = ref(false);

const res = useResource<SettingsDoc>(() => settingsApi.read());
const hist = useResource(() => settingsApi.history(50));
// M4: writes need the per-session token from the auth answer. After a reload with only the cookie there is
// none, so reads work but every Save is disabled with a short note on how to get a writable session back.
const canWrite = ref(getCsrf() !== null);
onMounted(() => { void res.run().then(() => { canWrite.value = getCsrf() !== null; }); void hist.run(); });

// local edit state, re-initialised whenever a fresh document loads. Values are dynamic by config type
// (scalar, or an L0-L3 / lead-class object), so the map is loosely typed for two-way binding.
const cfg = reactive<Record<string, any>>({});
const presetsText = ref('');
watch(() => res.data.value, d => {
  if (!d) return;
  for (const k of Object.keys(cfg)) delete cfg[k];
  for (const key of d.config.keys) cfg[key.key] = key.type === 'levels' || key.type === 'byLeadClass' ? { ...(key.value as object) } : key.value;
  presetsText.value = d.presets.text;
});

const visibleKeys = computed<ConfigKey[]>(() => (res.data.value?.config.keys ?? []).filter(k => showAdvanced.value || !k.advanced));
const enumOptions = (k: ConfigKey): string[] => (k.value === '' && !(k.options ?? []).includes('') ? ['', ...(k.options ?? [])] : (k.options ?? []));

// write results / errors
const cfgErrors = ref<FieldError[]>([]); const cfgTop = ref<string | null>(null); const cfgSaved = ref(false); const cfgSaving = ref(false);
const preErrors = ref<FieldError[]>([]); const preTop = ref<string | null>(null); const preSaved = ref(false); const preSaving = ref(false);
const cfgErrsFor = (key: string) => cfgErrors.value.filter(e => e.path === key || e.path.startsWith(`${key}.`));

function onWriteError(e: unknown, errs: typeof cfgErrors, top: typeof cfgTop): void {
  if (e instanceof SettingsError) { top.value = e.status === 409 ? t('set.errConflict') : e.status === 403 ? t('set.errForbidden') : null; errs.value = e.errors; }
  else if (e instanceof ApiError) top.value = e.kind === 'unauthorized' ? t('banner.unauthorized') : e.kind === 'timeout' ? t('banner.timeout') : t('banner.daemonOff');
  else top.value = t('banner.httpError');
}
function reload(): void { void res.run(); void hist.run(); }

async function saveConfig(): Promise<void> {
  const d = res.data.value; if (!d) return;
  cfgErrors.value = []; cfgTop.value = null; cfgSaved.value = false; cfgSaving.value = true;
  const set: Record<string, unknown> = {};
  for (const k of d.config.keys) {
    const now = cfg[k.key]; const was = k.value;
    if (k.type === 'levels' || k.type === 'byLeadClass') {
      const a = (now ?? {}) as Record<string, unknown>; const b = (was ?? {}) as Record<string, unknown>;
      for (const sub of Object.keys(a)) if (a[sub] !== b[sub]) set[`${k.key}.${sub}`] = a[sub];
    } else if (now !== was) set[k.key] = now;
  }
  if (!Object.keys(set).length) { cfgSaving.value = false; cfgSaved.value = true; return; }
  try { await settingsApi.writeConfig(set, d.config.revision); cfgSaved.value = true; reload(); }
  catch (e) { onWriteError(e, cfgErrors, cfgTop); } finally { cfgSaving.value = false; }
}
async function resetKey(key: string): Promise<void> {
  const d = res.data.value; if (!d) return;
  cfgErrors.value = []; cfgTop.value = null; cfgSaving.value = true;
  try { await settingsApi.writeConfig({ [key]: null }, d.config.revision); reload(); }
  catch (e) { onWriteError(e, cfgErrors, cfgTop); } finally { cfgSaving.value = false; }
}
async function savePresets(): Promise<void> {
  const d = res.data.value; if (!d) return;
  preErrors.value = []; preTop.value = null; preSaved.value = false; preSaving.value = true;
  try { await settingsApi.writePresets(presetsText.value, d.presets.revision); preSaved.value = true; reload(); }
  catch (e) { onWriteError(e, preErrors, preTop); } finally { preSaving.value = false; }
}
</script>

<template>
  <StateBanner v-if="res.loading.value || res.error.value" :loading="res.loading.value" :error="res.error.value" @retry="res.run" />
  <div v-else-if="res.data.value" class="grid">
    <nav class="tabs">
      <button v-for="s in sections" :key="s.id" :class="{ active: section === s.id }" @click="section = s.id">{{ t(s.key) }}</button>
      <button class="ghost" style="margin-left: auto;" @click="reload">{{ t('set.reload') }}</button>
    </nav>

    <p v-if="!canWrite" class="notoken" role="status">{{ t('set.noToken') }}</p>

    <!-- CONFIG -->
    <div v-show="section === 'config'" class="panel">
      <div class="row" style="justify-content: space-between;">
        <strong>{{ t('set.config') }}</strong>
        <label class="row" style="gap: 4px;"><input type="checkbox" v-model="showAdvanced" />{{ showAdvanced ? t('set.hideAdvanced') : t('set.showAdvanced') }}</label>
      </div>
      <p v-if="cfgTop" class="err" role="alert">{{ cfgTop }}</p>
      <p v-else-if="cfgErrors.length" class="err" role="alert">{{ t('set.fixErrors') }}</p>

      <div class="keys">
        <div v-for="k in visibleKeys" :key="k.key" class="k">
          <div class="klabel">
            <code class="mono">{{ k.key }}</code>
            <span v-if="k.deprecated" class="badge warn">{{ t('set.deprecated') }}</span>
            <span v-if="k.appliesAt === 'next start'" class="badge" :title="t('set.nextStart')">↻</span>
            <button class="linkish" @click="resetKey(k.key)" :disabled="!canWrite" :title="t('set.default', { v: JSON.stringify(k.default) })">{{ t('set.default', { v: String(JSON.stringify(k.default)).slice(0, 24) }) }}</button>
          </div>
          <p class="muted desc" v-if="k.description">{{ k.description }}</p>

          <input v-if="k.type === 'boolean'" type="checkbox" v-model="cfg[k.key]" />
          <select v-else-if="k.type === 'enum'" v-model="cfg[k.key]">
            <option v-for="o in enumOptions(k)" :key="o" :value="o">{{ o === '' ? '—' : o }}</option>
          </select>
          <input v-else-if="k.type === 'number'" type="number" step="any" :min="k.min" :max="k.max" v-model.number="cfg[k.key]" />
          <input v-else-if="k.type === 'integer'" type="number" step="1" :min="k.min" :max="k.max" v-model.number="cfg[k.key]" />
          <div v-else-if="k.type === 'levels'" class="row">
            <label v-for="lk in Object.keys(cfg[k.key])" :key="lk" class="sub"><span>{{ lk }}</span>
              <input type="number" step="any" :min="k.min" v-model.number="cfg[k.key][lk]" />
            </label>
          </div>
          <div v-else-if="k.type === 'byLeadClass'" class="row">
            <label v-for="cls in Object.keys(cfg[k.key])" :key="cls" class="sub"><span>{{ cls }}</span>
              <select v-model="cfg[k.key][cls]"><option v-for="o in k.options ?? []" :key="o" :value="o">{{ o }}</option></select>
            </label>
          </div>

          <small class="err" v-for="(e, i) in cfgErrsFor(k.key)" :key="i">{{ e.message }}</small>
        </div>
      </div>

      <details v-if="res.data.value.config.managed.length" class="managed">
        <summary class="muted">{{ t('set.managed') }} ({{ res.data.value.config.managed.length }})</summary>
        <div v-for="m in res.data.value.config.managed" :key="m.key" class="lockrow">
          <code class="mono">{{ m.key }}</code><span class="badge">{{ t('set.managed') }}</span><small class="muted">{{ m.reason }}</small>
        </div>
      </details>

      <div class="row" style="margin-top: 12px;">
        <button class="ghost" @click="saveConfig" :disabled="cfgSaving || !canWrite">{{ cfgSaving ? t('set.saving') : t('set.save') }}</button>
        <span v-if="cfgSaved" class="badge ok">{{ t('set.saved') }}</span>
      </div>
    </div>

    <!-- PRESETS -->
    <div v-show="section === 'presets'" class="panel">
      <strong>{{ t('set.presetsText') }}</strong>
      <p class="muted desc">{{ t('set.presetsHint') }}</p>
      <p v-if="res.data.value.presets.error" class="err" role="alert">⚠ {{ res.data.value.presets.error }}</p>
      <p v-if="preTop" class="err" role="alert">{{ preTop }}</p>
      <ul v-if="preErrors.length" class="err">
        <li v-for="(e, i) in preErrors" :key="i"><code class="mono">{{ e.path }}</code> {{ e.message }}</li>
      </ul>
      <textarea v-model="presetsText" rows="12" class="mono" spellcheck="false" :placeholder="t('set.presetsEmpty')"></textarea>
      <div class="row" style="margin: 8px 0 14px;">
        <button class="ghost" @click="savePresets" :disabled="preSaving || !canWrite">{{ preSaving ? t('set.saving') : t('set.save') }}</button>
        <span v-if="preSaved" class="badge ok">{{ t('set.saved') }}</span>
        <span v-if="!presetsText" class="muted">{{ t('set.presetsEmpty') }}</span>
      </div>

      <strong>{{ t('set.effective') }}</strong>
      <table>
        <thead><tr><th>{{ t('common.level') }}</th><th>roles</th><th>budget</th></tr></thead>
        <tbody>
          <tr v-for="(lv, lk) in res.data.value.presets.effective" :key="lk">
            <td><span class="badge lvl">{{ lk }}</span></td>
            <td>{{ lv.roles.map(r => `${r.role}×${r.count}@${r.start}`).join('  ') || '—' }}</td>
            <td>{{ lv.budgetUsd ?? '—' }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- ROLES -->
    <div v-show="section === 'roles'">
      <div v-if="!res.data.value.roles.editable" class="panel muted">{{ t('set.rolesNotReady') }}</div>
      <RoleEditor v-else v-for="it in res.data.value.roles.items" :key="it.role" :item="it" :can-write="canWrite" @saved="reload" />
    </div>

    <!-- HISTORY -->
    <div v-show="section === 'history'" class="panel">
      <div class="row" style="justify-content: space-between;">
        <strong>{{ t('set.history') }}</strong>
        <button class="ghost" @click="hist.run">{{ t('common.refresh') }}</button>
      </div>
      <StateBanner v-if="hist.loading.value || hist.error.value" :loading="hist.loading.value" :error="hist.error.value" @retry="hist.run" />
      <p v-else-if="!hist.data.value || !hist.data.value.entries.length" class="muted">{{ t('set.historyEmpty') }}</p>
      <table v-else>
        <thead><tr><th>{{ t('tl.thTime') }}</th><th>{{ t('set.source') }}</th><th>kind</th><th>{{ t('tl.thDetail') }}</th></tr></thead>
        <tbody>
          <tr v-for="(e, i) in hist.data.value.entries" :key="i">
            <td>{{ new Date(e.at).toLocaleString() }}</td>
            <td><span class="badge">{{ e.source }}</span></td>
            <td>{{ e.kind }}<template v-if="e.target"> · {{ e.target }}</template></td>
            <td>
              <span v-for="(c, j) in e.changes" :key="j" class="chg">
                <code class="mono">{{ c.path }}</code><template v-if="'to' in c"> {{ JSON.stringify(c.from) }} → {{ JSON.stringify(c.to) }}</template><template v-else> {{ t('set.changed') }}</template>
              </span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.keys { display: grid; grid-template-columns: 1fr; gap: 14px; margin-top: 12px; }
.k { border-bottom: 1px solid var(--line); padding-bottom: 12px; }
.klabel { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.desc { margin: 4px 0 8px; font-size: 12px; }
.k input[type=number], .k select, textarea { font: inherit; background: var(--panel-2); color: var(--ink); border: 1px solid var(--line); border-radius: 8px; padding: 6px 8px; }
textarea { width: 100%; resize: vertical; }
.sub { display: inline-flex; flex-direction: column; gap: 2px; font-size: 12px; color: var(--muted); }
.sub input, .sub select { width: 90px; }
.err { color: var(--bad); }
small.err { display: block; font-size: 11px; }
.linkish { background: none; border: none; color: var(--accent); cursor: pointer; font: inherit; font-size: 11px; padding: 0; }
.managed { margin-top: 12px; }
.lockrow { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; padding: 4px 0; }
.chg { display: inline-block; margin-right: 10px; }
.notoken { background: var(--panel-2); border: 1px solid var(--line); border-radius: 8px; padding: 8px 12px; color: var(--muted); font-size: 13px; }
</style>
