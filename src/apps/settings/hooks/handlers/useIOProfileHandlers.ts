// ui/src/apps/settings/hooks/handlers/useIOProfileHandlers.ts

import {
  storeCredential,
  getCredential,
  deleteAllCredentials,
  SECURE_FIELDS,
} from '../../../../api/credentials';
import { useSettingsStore } from '../../stores/settingsStore';
import type {
  IOProfile,
  ConnectionFieldValue,
  MqttConnection,
  PostgresConnection,
  GvretTcpConnection,
  SlcanConnection,
  SocketcanConnection,
  ModbusTcpConnection,
  SerialConnection,
  FrameLinkConnection,
  ConnectionTypeMap,
  ProfileKindId,
} from '../../../../hooks/useSettings';
import { isProfileKind } from '../../../../hooks/useSettings';
import { useSessionStore } from '../../../../stores/sessionStore';
import { withAppError } from '../../../../utils/appError';

export function useIOProfileHandlers() {
  // Store selectors
  const profiles = useSettingsStore((s) => s.ioProfiles.profiles);
  const defaultReadProfile = useSettingsStore((s) => s.ioProfiles.defaultReadProfile);
  const dialogPayload = useSettingsStore((s) => s.ui.dialogPayload);

  // Store actions
  const addProfile = useSettingsStore((s) => s.addProfile);
  const updateProfile = useSettingsStore((s) => s.updateProfile);
  const removeProfile = useSettingsStore((s) => s.removeProfile);
  const setDefaultReadProfile = useSettingsStore((s) => s.setDefaultReadProfile);
  const openDialog = useSettingsStore((s) => s.openDialog);
  const closeDialog = useSettingsStore((s) => s.closeDialog);
  const setDialogPayload = useSettingsStore((s) => s.setDialogPayload);

  // Global error dialog
  const showAppError = useSessionStore((s) => s.showAppError);

  // Open dialog for adding a new profile
  const handleAddIOProfile = () => {
    const profileForm: IOProfile = {
      id: '',
      name: '',
      kind: 'mqtt',
      connection: {} satisfies MqttConnection,
    };
    setDialogPayload({ editingProfileId: null, profileForm });
    openDialog('ioProfile');
  };

  // Open dialog for editing an existing profile
  const handleEditIOProfile = async (id: string) => {
    const profile = profiles.find((p) => p.id === id);
    if (!profile) return;

    // Load secure fields from keyring into a plain record, then merge back
    const secretOverrides: Record<string, string> = {};
    const conn = profile.connection as Record<string, unknown>;
    for (const field of SECURE_FIELDS) {
      if (conn[`_${field}_stored`]) {
        try {
          const value = await getCredential(id, field);
          if (value) {
            secretOverrides[field] = value;
          }
        } catch (error) {
          console.error(`Failed to load ${field} from keyring:`, error);
        }
      }
    }

    const connectionWithSecrets = { ...profile.connection, ...secretOverrides };
    setDialogPayload({
      editingProfileId: id,
      profileForm: { ...profile, connection: connectionWithSecrets } as IOProfile,
    });
    openDialog('ioProfile');
  };

  // Open delete confirmation dialog
  const handleDeleteIOProfile = (id: string) => {
    const profile = profiles.find((p) => p.id === id) || null;
    setDialogPayload({ ioProfileToDelete: profile });
    openDialog('deleteIOProfile');
  };

  // Confirm and execute profile deletion
  const handleConfirmDeleteIOProfile = async () => {
    const profile = dialogPayload.ioProfileToDelete;
    if (!profile) {
      closeDialog('deleteIOProfile');
      return;
    }

    // Delete credentials from keyring
    try {
      await deleteAllCredentials(profile.id);
    } catch (error) {
      console.error('Failed to delete credentials from keyring:', error);
      // Continue with profile deletion even if keyring cleanup fails
    }

    removeProfile(profile.id);
    closeDialog('deleteIOProfile');
    setDialogPayload({ ioProfileToDelete: null });
  };

  // Cancel profile deletion
  const handleCancelDeleteIOProfile = () => {
    closeDialog('deleteIOProfile');
    setDialogPayload({ ioProfileToDelete: null });
  };

  // Duplicate a profile
  const handleDuplicateIOProfile = (profile: IOProfile) => {
    const copy: IOProfile = {
      ...profile,
      id: `io_${Date.now()}`,
      name: `${profile.name} (Copy)`,
    };
    addProfile(copy);
  };

  // Save profile (create or update)
  const handleSaveProfile = async () => {
    const { editingProfileId, profileForm } = dialogPayload;

    // Validate profile name is not empty
    if (!profileForm.name.trim()) {
      showAppError('Validation Error', 'Profile name is required.');
      return;
    }

    // Validate profile name is unique
    const isDuplicate = profiles.some(
      (p) => p.name === profileForm.name && p.id !== editingProfileId
    );
    if (isDuplicate) {
      showAppError('Validation Error', 'A profile with this name already exists. Please choose a unique name.');
      return;
    }

    // Validate required fields for specific profile types
    if (profileForm.kind === 'slcan' || profileForm.kind === 'serial') {
      if (!profileForm.connection.port) {
        showAppError('Validation Error', 'Serial port is required. Please select a port from the dropdown.');
        return;
      }
    }
    if (profileForm.kind === 'modbus_tcp') {
      if (!profileForm.connection.host) {
        showAppError('Validation Error', 'Host is required for Modbus TCP.');
        return;
      }
    }

    // Apply default connection values
    const processedForm = applyConnectionDefaults(profileForm);

    // Determine the profile ID
    const profileId = editingProfileId || `io_${Date.now()}`;

    // Store secure fields in keyring and remove from connection object
    const connRecord = { ...processedForm.connection } as Record<string, unknown>;
    for (const field of SECURE_FIELDS) {
      const value = connRecord[field];
      if (value && typeof value === 'string' && value.trim()) {
        const ok = await withAppError('Credential Error', `Failed to securely store ${field}.`, () =>
          storeCredential(profileId, field, value)
        );
        if (!ok) return;
        connRecord[`_${field}_stored`] = true;
      }
      delete connRecord[field];
    }

    const profileToSave: IOProfile = {
      ...processedForm,
      id: profileId,
      connection: connRecord as ConnectionTypeMap[typeof processedForm.kind],
    } as IOProfile;

    if (editingProfileId) {
      updateProfile(editingProfileId, profileToSave);
    } else {
      addProfile(profileToSave);
    }

    closeDialog('ioProfile');
  };

  // Cancel profile edit/create
  const handleCancelProfile = () => {
    closeDialog('ioProfile');
  };

  // Update a field on the profile form
  // NOTE: We use getState() instead of the dialogPayload from the closure to avoid
  // stale closure issues when multiple fields are updated in a single event handler.
  const updateProfileField = (field: keyof IOProfile, value: string | ProfileKindId) => {
    const currentPayload = useSettingsStore.getState().ui.dialogPayload;
    setDialogPayload({
      profileForm: { ...currentPayload.profileForm, [field]: value } as IOProfile,
    });
  };

  // Update a connection field
  // NOTE: We use getState() instead of the dialogPayload from the closure to avoid
  // stale closure issues when multiple fields are updated in a single event handler.
  const updateConnectionField = (key: string, value: ConnectionFieldValue) => {
    const currentPayload = useSettingsStore.getState().ui.dialogPayload;
    const prev = currentPayload.profileForm;
    setDialogPayload({
      profileForm: {
        ...prev,
        connection: { ...prev.connection, [key]: value },
      } as IOProfile,
    });
  };

  // Update MQTT format settings
  // NOTE: We use getState() instead of the dialogPayload from the closure to avoid
  // stale closure issues when multiple fields are updated in a single event handler.
  const updateMqttFormat = (
    format: 'json' | 'savvycan' | 'decode',
    field: 'topic' | 'enabled',
    value: string | boolean
  ) => {
    const currentPayload = useSettingsStore.getState().ui.dialogPayload;
    const { profileForm } = currentPayload;

    if (!isProfileKind(profileForm, 'mqtt')) return;

    const formats = profileForm.connection.formats || {
      json: { topic: '', enabled: false },
      savvycan: { topic: '', enabled: false },
      decode: { topic: '', enabled: false },
    };

    setDialogPayload({
      profileForm: {
        ...profileForm,
        connection: {
          ...profileForm.connection,
          formats: {
            ...formats,
            [format]: {
              ...formats[format],
              [field]: value,
            },
          },
        },
      },
    });
  };

  // Toggle default read profile
  const toggleDefaultRead = (profileId: string) => {
    if (defaultReadProfile === profileId) {
      setDefaultReadProfile(null);
    } else {
      setDefaultReadProfile(profileId);
    }
  };

  return {
    handleAddIOProfile,
    handleEditIOProfile,
    handleDeleteIOProfile,
    handleConfirmDeleteIOProfile,
    handleCancelDeleteIOProfile,
    handleDuplicateIOProfile,
    handleSaveProfile,
    handleCancelProfile,
    updateProfileField,
    updateConnectionField,
    updateMqttFormat,
    toggleDefaultRead,
  };
}

// Helper: Apply default connection values based on profile kind.
// Each case narrows the discriminated union so TypeScript knows the connection type.
function applyConnectionDefaults(profile: IOProfile): IOProfile {
  switch (profile.kind) {
    case 'mqtt': {
      const conn: MqttConnection = { ...profile.connection };
      if (!conn.host) conn.host = 'localhost';
      if (!conn.port) conn.port = '1883';
      return { ...profile, connection: conn };
    }
    case 'postgres': {
      const conn: PostgresConnection = { ...profile.connection };
      if (!conn.host) conn.host = 'localhost';
      if (!conn.port) conn.port = '5432';
      if (!conn.database) conn.database = 'wiretap';
      return { ...profile, connection: conn };
    }
    case 'gvret_tcp': {
      const conn: GvretTcpConnection = { ...profile.connection };
      if (!conn.host) conn.host = '192.168.1.100';
      if (!conn.port) conn.port = '23';
      return { ...profile, connection: conn };
    }
    case 'framelink': {
      const conn: FrameLinkConnection = { ...profile.connection };
      if (!conn.port) conn.port = '120';
      return { ...profile, connection: conn };
    }
    case 'slcan': {
      const conn: SlcanConnection = { ...profile.connection };
      if (!conn.baud_rate) conn.baud_rate = '115200';
      if (!conn.bitrate) conn.bitrate = '500000';
      if (conn.silent_mode === undefined) conn.silent_mode = true;
      return { ...profile, connection: conn };
    }
    case 'socketcan': {
      const conn: SocketcanConnection = { ...profile.connection };
      if (!conn.interface) conn.interface = 'can0';
      return { ...profile, connection: conn };
    }
    case 'modbus_tcp': {
      const conn: ModbusTcpConnection = { ...profile.connection };
      if (!conn.host) conn.host = '192.168.1.100';
      if (!conn.port) conn.port = '502';
      if (!conn.unit_id) conn.unit_id = '1';
      return { ...profile, connection: conn };
    }
    case 'serial': {
      const conn: SerialConnection = { ...profile.connection };
      if (!conn.baud_rate) conn.baud_rate = '115200';
      if (!conn.data_bits) conn.data_bits = '8';
      if (!conn.stop_bits) conn.stop_bits = '1';
      if (!conn.parity) conn.parity = 'none';
      return { ...profile, connection: conn };
    }
    default:
      return profile;
  }
}

export type IOProfileHandlers = ReturnType<typeof useIOProfileHandlers>;
