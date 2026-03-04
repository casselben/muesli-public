/**
 * One-time script: reads ASANA_PAT from .env, calls Asana API to get
 * workspace, project, section, and custom field GIDs, then appends them to .env.
 * Run from repo root: node scripts/fetch-asana-ids.js
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const envPath = path.join(__dirname, '..', '.env');

function loadEnv() {
  const content = fs.readFileSync(envPath, 'utf8');
  const env = {};
  content.split('\n').forEach(line => {
    const m = line.match(/^\s*([^#=]+)=(.*)$/);
    if (m) env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, '');
  });
  return env;
}

function asanaGet(pathname) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'app.asana.com',
      path: '/api/1.0' + pathname,
      method: 'GET',
      headers: { 'Authorization': 'Bearer ' + process.env.ASANA_PAT }
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          if (data.errors) reject(new Error(JSON.stringify(data.errors)));
          else resolve(data);
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function main() {
  require('dotenv').config({ path: envPath });
  if (!process.env.ASANA_PAT) {
    console.error('ASANA_PAT not set in .env');
    process.exit(1);
  }

  const out = {};

  // 1. Workspaces
  const workspacesData = await asanaGet('/workspaces');
  const workspaces = workspacesData.data || [];
  if (workspaces.length === 0) {
    console.error('No workspaces found');
    process.exit(1);
  }
  out.ASANA_WORKSPACE_GID = workspaces[0].gid;
  console.log('Workspace:', out.ASANA_WORKSPACE_GID);

  // 2. Projects
  const projectsData = await asanaGet('/projects?workspace=' + out.ASANA_WORKSPACE_GID);
  const projects = projectsData.data || [];
  if (projects.length === 0) {
    console.error('No projects found in workspace');
    process.exit(1);
  }
  out.ASANA_PROJECT_GID = projects[0].gid;
  console.log('Project:', out.ASANA_PROJECT_GID);

  // 3. Sections
  const sectionsData = await asanaGet('/projects/' + out.ASANA_PROJECT_GID + '/sections');
  const sections = sectionsData.data || [];
  const todoSection = sections.find(s => /to do/i.test(s.name));
  const doingSection = sections.find(s => /doing/i.test(s.name));
  const doneSection = sections.find(s => /done/i.test(s.name));
  out.ASANA_SECTION_TODO_GID = (todoSection || sections[0]).gid;
  if (doingSection) out.ASANA_SECTION_DOING_GID = doingSection.gid;
  if (doneSection) out.ASANA_SECTION_DONE_GID = doneSection.gid;
  console.log('Section To do:', out.ASANA_SECTION_TODO_GID);

  // 4. Custom field settings
  const cfsData = await asanaGet(
    '/projects/' + out.ASANA_PROJECT_GID + '/custom_field_settings?opt_fields=custom_field.name,custom_field.gid,custom_field.resource_subtype,custom_field.enum_options.name,custom_field.enum_options.gid'
  );
  const cfs = cfsData.data || [];
  for (const cfSetting of cfs) {
    const cf = cfSetting.custom_field || {};
    const name = (cf.name || '').toLowerCase();
    if (name === 'priority') {
      out.ASANA_FIELD_PRIORITY_GID = cf.gid;
      const opts = cf.enum_options || [];
      opts.forEach(opt => {
        const oname = (opt.name || '').toLowerCase();
        if (oname === 'high') out.ASANA_PRIORITY_HIGH_GID = opt.gid;
        else if (oname === 'medium') out.ASANA_PRIORITY_MEDIUM_GID = opt.gid;
        else if (oname === 'low') out.ASANA_PRIORITY_LOW_GID = opt.gid;
      });
    } else if (name === 'status') {
      out.ASANA_FIELD_STATUS_GID = cf.gid;
      const opts = cf.enum_options || [];
      opts.forEach(opt => {
        const oname = (opt.name || '').toLowerCase();
        if (/not started/i.test(oname)) out.ASANA_STATUS_NOT_STARTED_GID = opt.gid;
        else if (/on track/i.test(oname)) out.ASANA_STATUS_ONTRACK_GID = opt.gid;
        else if (/at risk/i.test(oname)) out.ASANA_STATUS_ATRISK_GID = opt.gid;
        else if (/off track/i.test(oname)) out.ASANA_STATUS_OFFTRACK_GID = opt.gid;
      });
    } else if (name === 'owner') {
      const subtype = (cf.resource_subtype || cf.type || '').toLowerCase();
      if (subtype === 'text') {
        out.ASANA_FIELD_OWNER_TEXT_GID = cf.gid;
      } else {
        out.ASANA_FIELD_OWNER_GID = cf.gid;
      }
    }
  }
  console.log('Priority field:', out.ASANA_FIELD_PRIORITY_GID);
  console.log('Status field:', out.ASANA_FIELD_STATUS_GID, 'Not started:', out.ASANA_STATUS_NOT_STARTED_GID);
  console.log('Owner (text) field:', out.ASANA_FIELD_OWNER_TEXT_GID, 'Owner (enum) field:', out.ASANA_FIELD_OWNER_GID);

  // Append to .env
  const existing = fs.readFileSync(envPath, 'utf8');
  const lines = [
    '',
    '# Asana (from fetch-asana-ids.js)',
    ...Object.entries(out).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`)
  ];
  if (existing.trimEnd().endsWith('\n')) {
    fs.appendFileSync(envPath, lines.join('\n') + '\n');
  } else {
    fs.appendFileSync(envPath, '\n' + lines.join('\n') + '\n');
  }
  console.log('Appended', Object.keys(out).length, 'variables to .env');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
