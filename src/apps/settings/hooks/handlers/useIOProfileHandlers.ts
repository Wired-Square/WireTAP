// ui/src/apps/settings/hooks/handlers/useIOProfileHandlers.ts

import {
  storeCredential,
  getCredential,
  deleteAllCredentials,
  SECURE_FIELDS,
} from '../../../../api/credentials';
import { useSettingsStore, type IOProfile } from '../../stores/settingsStore';
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
    setDialogPayload({
      editingProfileId: null,
      profileForm: {
        id: '',
        name: '',
        kind: 'mqtt',
        connection: {},
      },
    });
    openDialog('ioProfile');
  };

  // Open dialog for editing an existing profile
  const handleEditIOProfile = async (id: string) => {
    const profile = profiles.find((p) => p.id === id);
    if (!profile) return;

    // Load secure fields from keyring
    const connectionWithSecrets = { ...profile.connection };
    for (const field of SECURE_FIELDS) {
      if (connectionWithSecrets[`_${field}_stored`]) {
        try {
          const value = await getCredential(id, field);
          if (value) {
            connectionWithSecrets[field] = value;
          }
        } catch (error) {
          console.error(`Failed to load ${field} from keyring:`, error);
        }
      }
    }

    setDialogPayload({
      editingProfileId: id,
      profileForm: { ...profile, connection: connectionWithSecrets },
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
    const connectionWithoutSecrets = { ...processedForm.connection };
    for (const field of SECURE_FIELDS) {
      const value = connectionWithoutSecrets[field];
      if (value && typeof value === 'string' && value.trim()) {
        const ok = await withAppError('Credential Error', `Failed to securely store ${field}.`, () =>
          storeCredential(profileId, field, value)
        );
        if (!ok) return;
        connectionWithoutSecrets[`_${field}_stored`] = true;
      }
      delete connectionWithoutSecrets[field];
    }

    const profileToSave: IOProfile = {
      ...processedForm,
      id: profileId,
      connection: connectionWithoutSecrets,
    };

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
  const updateProfileField = (field: keyof IOProfile, value: any) => {
    const currentPayload = useSettingsStore.getState().ui.dialogPayload;
    setDialogPayload({
      profileForm: { ...currentPayload.profileForm, [field]: value },
    });
  };

  // Update a connection field
  // NOTE: We use getState() instead of the dialogPayload from the closure to avoid
  // stale closure issues when multiple fields are updated in a single event handler.
  const updateConnectionField = (key: string, value: string | boolean) => {
    const currentPayload = useSettingsStore.getState().ui.dialogPayload;
    setDialogPayload({
      profileForm: {
        ...currentPayload.profileForm,
        connection: { ...currentPayload.profileForm.connection, [key]: value },
      },
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
    const formats = currentPayload.profileForm.connection.formats || {
      json: { topic: '', enabled: false },
      savvycan: { topic: '', enabled: false },
      decode: { topic: '', enabled: false },
    };

    setDialogPayload({
      profileForm: {
        ...currentPayload.profileForm,
        connection: {
          ...currentPayload.profileForm.connection,
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

// Helper: Apply default connection values based on profile kind
function applyConnectionDefaults(profile: IOProfile): IOProfile {
  const processed = { ...profile, connection: { ...profile.connection } };

  switch (profile.kind) {
    case 'mqtt':
      if (!processed.connection.host) processed.connection.host = 'localhost';
      if (!processed.connection.port) processed.connection.port = '1883';
      break;
    case 'postgres':
      if (!processed.connection.host) processed.connection.host = 'localhost';
      if (!processed.connection.port) processed.connection.port = '5432';
      if (!processed.connection.database) processed.connection.database = 'wiretap';
      break;
    case 'gvret_tcp':
      if (!processed.connection.host) processed.connection.host = '192.168.1.100';
      if (!processed.connection.port) processed.connection.port = '23';
      break;
    case 'slcan':
      if (!processed.connection.baud_rate) processed.connection.baud_rate = '115200';
      if (!processed.connection.bitrate) processed.connection.bitrate = '500000';
      if (processed.connection.silent_mode === undefined) processed.connection.silent_mode = true;
      break;
    case 'socketcan':
      if (!processed.connection.interface) processed.connection.interface = 'can0';
      break;
    case 'modbus_tcp':
      if (!processed.connection.host) processed.connection.host = '192.168.1.100';
      if (!processed.connection.port) processed.connection.port = '502';
      if (!processed.connection.unit_id) processed.connection.unit_id = '1';
      break;
    case 'serial':
      if (!processed.connection.baud_rate) processed.connection.baud_rate = '115200';
      if (!processed.connection.data_bits) processed.connection.data_bits = '8';
      if (!processed.connection.stop_bits) processed.connection.stop_bits = '1';
      if (!processed.connection.parity) processed.connection.parity = 'none';
      break;
  }

  return processed;
}

export type IOProfileHandlers = ReturnType<typeof useIOProfileHandlers>;
