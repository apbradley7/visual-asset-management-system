/*
 * Copyright 2022 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import {
    Modal,
    Box,
    SpaceBetween,
    Button,
    Form,
    FormField,
    Input,
    Textarea,
    MultiselectProps,
} from "@cloudscape-design/components";
import { useState } from "react";
import { API } from "aws-amplify";

interface CreateDatabaseProps {
    open: boolean;
    setOpen: (open: boolean) => void;
    setReload: (reload: boolean) => void;
    initState?: DatabaseFields;
}

interface DatabaseFields {
    databaseId: string;
    description: string;
}

// when a string is all lower case, return null, otherwise return the string "All lower case letters only"
function validateDatabaseNameLowercase(name: string) {
    return name.match(/^[a-z0-9_-]+$/) !== null
        ? null
        : "All lower case letters only. No special characters except - and _";
}

// when a string is between 4 and 64 characters, return null, otherwise return the string "Between 4 and 64 characters"
function validateDatabaseNameLength(name: string) {
    return name.length >= 4 && name.length <= 64 ? null : "Between 4 and 64 characters";
}

// chain together the above three functions, when they return null, then return null
function validateDatabaseName(name: string) {
    return validateDatabaseNameLowercase(name) || validateDatabaseNameLength(name);
}

// when a string is between the given min and max characters, return null, otherwise return an error message including the range
function validateDatabaseDescriptionLength(description: string) {
    const min = 4,
        max = 256;
    return description.length >= min && description.length <= max
        ? null
        : `Between ${min} and ${max} characters`;
}

export default function CreateDatabase({
    open,
    setOpen,
    setReload,
    initState,
}: CreateDatabaseProps) {
    // const initFormState: DatabaseFields = {
    //     databaseId: "",
    //     description: "",
    // };
    // if (initState) {
    //     Object.assign(initFormState, initState);
    // }
    const [formState, setFormState] = useState<DatabaseFields>({
        databaseId: "",
        description: "",
        ...initState,
    });

    // eslint-disable-next-line no-mixed-operators
    const createOrUpdate = (initState && initState.databaseId && "Update") || "Create";

    const [selectedOptions, setSelectedOptions] = useState<MultiselectProps.Option[]>([]);

    const [groupOptions, setGroupOptions] = useState<MultiselectProps.Option[]>([]);
    const [loadingGroups, setLoadingGroups] = useState(true);
    const [inProgress, setInProgress] = useState(false);
    const [formError, setFormError] = useState("");

    return (
        <Modal
            onDismiss={() => {
                setOpen(false);
                setFormState({ databaseId: "", description: "" });
                setFormError("");
            }}
            visible={open}
            closeAriaLabel="Close modal"
            footer={
                <Box float="right">
                    <SpaceBetween direction="horizontal" size="xs">
                        <Button
                            variant="link"
                            onClick={() => {
                                setOpen(false);
                                setFormState({ databaseId: "", description: "" });
                                setFormError("");
                            }}
                        >
                            Cancel
                        </Button>
                        <Button
                            variant="primary"
                            onClick={() => {
                                setInProgress(true);
                                API.put("api", `databases`, {
                                    body: {
                                        ...formState,
                                    },
                                })
                                    .then((res) => {
                                        console.log("create database", res);
                                        setOpen(false);
                                        setReload(true);
                                    })
                                    .catch((err) => {
                                        console.log("create database error", err);
                                        let msg = `Unable to ${createOrUpdate} database. Error: Request failed with status code ${err.response.status}`;
                                        setFormError(msg);
                                    })
                                    .finally(() => {
                                        setInProgress(false);
                                    });
                            }}
                            disabled={
                                inProgress ||
                                !(
                                    validateDatabaseName(formState.databaseId) === null &&
                                    validateDatabaseDescriptionLength(formState.description) ===
                                        null
                                )
                            }
                            data-testid={`${createOrUpdate}-database-button`}
                        >
                            {createOrUpdate} Database
                        </Button>
                    </SpaceBetween>
                </Box>
            }
            header={`${createOrUpdate} Database`}
        >
            <form onSubmit={(e) => e.preventDefault()}>
                <Form errorText={formError}>
                    <SpaceBetween direction="vertical" size="s">
                        <FormField
                            label="Database Name"
                            errorText={validateDatabaseName(formState.databaseId)}
                            constraintText="Required. All lower case, no special chars or spaces except - and _ only letters for first character min 4 and max 64"
                        >
                            <Input
                                value={formState.databaseId}
                                disabled={
                                    inProgress ||
                                    (initState && initState.databaseId && true) ||
                                    false
                                }
                                onChange={({ detail }) =>
                                    setFormState({ ...formState, databaseId: detail.value })
                                }
                                placeholder="Database Name"
                                data-testid="database-name"
                            />
                        </FormField>
                        <FormField
                            label="Database Description"
                            constraintText="Required. Max 256 characters."
                            errorText={validateDatabaseDescriptionLength(formState.description)}
                        >
                            <Textarea
                                value={formState.description}
                                disabled={inProgress}
                                onChange={({ detail }) =>
                                    setFormState({ ...formState, description: detail.value })
                                }
                                rows={4}
                                placeholder="Database Description"
                                data-testid="database-desc"
                            />
                        </FormField>
                    </SpaceBetween>
                </Form>
            </form>
        </Modal>
    );
}
