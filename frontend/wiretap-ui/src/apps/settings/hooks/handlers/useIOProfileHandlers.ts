// ui/src/apps/settings/hooks/handlers/useIOProfileHandlers.ts

import {
  getCredential,
  deleteAllCredentials,
  SECURE_FIELDS,
} from '../../../../api/credentials';
import { useSettingsStore } from '../../stores/settingsStore';
import type {
  IOProfile,
  ConnectionFieldValue,
  MqttConnection,
  ProfileKindId,
} from '../../../../hooks/useSettings';
import {
  applyConnectionDefaults,
  newSavedProfileId,
  storeProfileSecrets,
  validateProfileForm,
} from '../../../../settings/ioProfileForm';
import { clearProfileProbeCache } from '../../../../api/ephemeralProfiles';
import { useSessionStore } from '../../../../stores/sessionStore';
import { useAdHocProfileStore } from '../../../../stores/adHocProfileStore';
import { withAppError } from '../../../../utils/appError';

/** Validation messages, matching `ProfileValidationError`. */
const VALIDATION_MESSAGES = {
  nameRequired: 'Profile name is required.',
  nameDuplicate: 'A profile with this name already exists. Please choose a unique name.',
  portRequired: 'Serial port is required. Please select a port from the dropdown.',
  hostRequired: 'Host is required for Modbus TCP.',
} as const;

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
      id: newSavedProfileId(),
      name: `${profile.name} (Copy)`,
    };
    addProfile(copy);
  };

  // Save profile (create or update)
  const handleSaveProfile = async () => {
    const { editingProfileId, profileForm } = dialogPayload;

    const takenNames = new Set(
      profiles.filter((p) => p.id !== editingProfileId).map((p) => p.name)
    );
    const invalid = validateProfileForm(profileForm, takenNames);
    if (invalid) {
      showAppError('Validation Error', VALIDATION_MESSAGES[invalid]);
      return;
    }

    // Apply default connection values
    const processedForm = applyConnectionDefaults(profileForm);

    // Determine the profile ID
    const profileId = editingProfileId || newSavedProfileId();

    // Secrets go to the keyring, never into settings.json.
    let profileToSave: IOProfile;
    try {
      profileToSave = await storeProfileSecrets(processedForm, profileId);
    } catch (e) {
      showAppError('Credential Error', 'Failed to securely store a credential.', String(e));
      return;
    }

    if (editingProfileId) {
      updateProfile(editingProfileId, profileToSave);
      // The id is unchanged but the device behind it may not be, so a cached
      // probe would describe the old one.
      await clearProfileProbeCache(editingProfileId);
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

  // Promote an ad-hoc device to a saved profile, then drop it from the
  // ephemeral registry so it appears once, in the saved list.
  const handleSaveAdHocProfile = async (profile: IOProfile) => {
    const takenNames = new Set(profiles.map((p) => p.name));
    let name = profile.name;
    for (let n = 2; takenNames.has(name); n++) {
      name = `${profile.name} (${n})`;
    }
    // An ad-hoc device keeps its secrets inline, since it never reaches disk.
    // Saving it does, so they move to the keyring first.
    const toSave = await storeProfileSecrets(
      { ...profile, name } as IOProfile,
      newSavedProfileId(),
    );
    addProfile(toSave);
    await withAppError('Discard Failed', 'Saved, but could not clear the unsaved copy.', () =>
      useAdHocProfileStore.getState().discard(profile.id)
    );
  };

  const handleDiscardAdHocProfile = async (profileId: string) => {
    // The backend refuses while a session still holds the device.
    await withAppError('Discard Failed', 'Could not discard this device.', () =>
      useAdHocProfileStore.getState().discard(profileId)
    );
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
    handleSaveAdHocProfile,
    handleDiscardAdHocProfile,
    updateProfileField,
    updateConnectionField,
    toggleDefaultRead,
  };
}

export type IOProfileHandlers = ReturnType<typeof useIOProfileHandlers>;
