//! Known frontmatter fields, the flat extension field set and the field
//! order of the page.
//!
//! Known fields are typed.  The order in which a page declares its fields
//! is part of the metadata, because a rewrite must not move them.  A field
//! the page does not declare joins the end of that order; the declaration
//! order of the known fields only breaks ties there.

use std::collections::BTreeMap;

use serde_yaml::{Mapping, Value};

use super::Error;

/// Known fields that hold a single string, in schema order.
///
/// The list follows the `string` rows of `assets/SCHEMA.md`; a string field
/// added to [`PageMetadata`] must join it.
const STRING_FIELDS: [&str; 5] =
    ["title", "type", "description", "timestamp", "resource"];

/// One entry of `supersedes` or `superseded_by`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Relation {
    /// Page path relative to the bundle root.
    pub path: String,
    /// Why the relation exists.
    pub reason: String,
}

impl Relation {
    /// Decode one relation entry.
    fn decode(mapping: Mapping, field: &str) -> Result<Self, Error> {
        let mut mapping = mapping;
        let relation = Self {
            path: required_string_at(
                &mut mapping,
                "path",
                &join(field, "path"),
            )?,
            reason: required_string_at(
                &mut mapping,
                "reason",
                &join(field, "reason"),
            )?,
        };
        reject_extra_fields(&mapping, field)?;
        Ok(relation)
    }

    /// Encode one relation entry.
    fn to_value(&self) -> Value {
        let mut mapping = Mapping::new();
        insert_string(&mut mapping, "path", &self.path);
        insert_string(&mut mapping, "reason", &self.reason);
        Value::Mapping(mapping)
    }
}

/// One entry of `contradictions`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Contradiction {
    /// Path of the conflicting page.
    pub path: String,
    /// Claims that conflict.
    pub claims: Vec<String>,
    /// Date the conflict was detected.
    pub detected: String,
    /// `unresolved` or a description of the resolution.
    pub resolution: String,
}

impl Contradiction {
    /// Decode one contradiction entry.
    fn decode(mapping: Mapping, field: &str) -> Result<Self, Error> {
        let mut mapping = mapping;
        let contradiction = Self {
            path: required_string_at(
                &mut mapping,
                "path",
                &join(field, "path"),
            )?,
            claims: required_string_list_at(
                &mut mapping,
                "claims",
                &join(field, "claims"),
            )?,
            detected: required_string_at(
                &mut mapping,
                "detected",
                &join(field, "detected"),
            )?,
            resolution: required_string_at(
                &mut mapping,
                "resolution",
                &join(field, "resolution"),
            )?,
        };
        reject_extra_fields(&mapping, field)?;
        Ok(contradiction)
    }

    /// Encode one contradiction entry.
    fn to_value(&self) -> Value {
        let mut mapping = Mapping::new();
        insert_string(&mut mapping, "path", &self.path);
        mapping.insert(Value::from("claims"), string_sequence(&self.claims));
        insert_string(&mut mapping, "detected", &self.detected);
        insert_string(&mut mapping, "resolution", &self.resolution);
        Value::Mapping(mapping)
    }
}

/// Value of a field that `assets/SCHEMA.md` does not declare.
///
/// The wrapper keeps the full YAML structure of the value.  YAML numbers
/// may be floats, so such values only support partial equality.
#[derive(Debug, Clone)]
pub struct ExtensionValue(Value);

impl From<Value> for ExtensionValue {
    fn from(value: Value) -> Self {
        Self(value)
    }
}

impl PartialEq for ExtensionValue {
    fn eq(&self, other: &Self) -> bool {
        self.0 == other.0
    }
}

impl PartialEq<Value> for ExtensionValue {
    fn eq(&self, other: &Value) -> bool {
        &self.0 == other
    }
}

impl std::ops::Deref for ExtensionValue {
    type Target = Value;

    fn deref(&self) -> &Value {
        &self.0
    }
}

/// Metadata owned by the page document model.
#[derive(Debug, Clone, PartialEq)]
pub struct PageMetadata {
    /// Page title (`title`, required).
    pub title: String,
    /// Page type (`type`, required).
    pub page_type: String,
    /// One-line summary (`description`).
    pub description: Option<String>,
    /// Content confirmation time in UTC seconds (`timestamp`, required).
    pub timestamp: String,
    /// External asset URI (`resource`).
    pub resource: Option<String>,
    /// Referenced pages (`sources`).
    pub sources: Option<Vec<String>>,
    /// Tags (`tags`, required).
    pub tags: Vec<String>,
    /// Pages this page overrides (`supersedes`).
    pub supersedes: Option<Vec<Relation>>,
    /// Pages that override this page (`superseded_by`).
    pub superseded_by: Option<Vec<Relation>>,
    /// Recorded conflicts (`contradictions`).
    pub contradictions: Option<Vec<Contradiction>>,
    /// Fields the schema does not declare, keyed by field name.
    pub extensions: BTreeMap<String, ExtensionValue>,
    /// Field names in the order the page declares them.
    field_order: Vec<String>,
}

impl PageMetadata {
    /// Read known fields out of `mapping`, keep the rest as extensions, and
    /// record the order of the field names.
    pub(super) fn from_mapping(mut mapping: Mapping) -> Result<Self, Error> {
        let field_order = declared_order(&mapping)?;
        let metadata = Self {
            title: required_string(&mut mapping, "title")?,
            page_type: required_string(&mut mapping, "type")?,
            description: optional_string(&mut mapping, "description")?,
            timestamp: required_string(&mut mapping, "timestamp")?,
            resource: optional_string(&mut mapping, "resource")?,
            sources: optional_string_list(&mut mapping, "sources")?,
            tags: required_string_list(&mut mapping, "tags")?,
            supersedes: optional_objects(
                &mut mapping,
                "supersedes",
                Relation::decode,
            )?,
            superseded_by: optional_objects(
                &mut mapping,
                "superseded_by",
                Relation::decode,
            )?,
            contradictions: optional_objects(
                &mut mapping,
                "contradictions",
                Contradiction::decode,
            )?,
            extensions: BTreeMap::new(),
            field_order,
        };
        Ok(Self { extensions: extension_fields(mapping), ..metadata })
    }

    /// Set one field from a YAML value.
    ///
    /// Known fields are decoded by the schema, so a value of the wrong type
    /// is rejected; an unknown name becomes an extension field.
    ///
    /// # Errors
    ///
    /// Fails when the value does not decode into the field, or when an
    /// extension field reuses a schema field name.
    pub fn set_field(&mut self, name: &str, value: Value) -> Result<(), Error> {
        let mut mapping = self.to_mapping()?;
        mapping.insert(Value::from(name), value);
        *self = Self::from_mapping(mapping)?;
        Ok(())
    }

    /// Set one field from a value given as command line text.
    ///
    /// A string field takes the text as written, so a colon, a number shape
    /// or a YAML mark stays part of the value.  Every other field decodes
    /// the text as YAML, so typed values keep their structure.
    ///
    /// # Errors
    ///
    /// Fails when the text is not valid YAML, when the value does not decode
    /// into the field, or when an extension field reuses a schema field name.
    pub fn set_field_text(
        &mut self,
        name: &str,
        text: &str,
    ) -> Result<(), Error> {
        let value = if STRING_FIELDS.contains(&name) {
            Value::from(text)
        } else {
            serde_yaml::from_str(text).map_err(|error| Error::InvalidValue {
                message: error.to_string(),
            })?
        };
        self.set_field(name, value)
    }

    /// Remove one field.
    ///
    /// # Errors
    ///
    /// Fails when the field is required, because the model cannot express a
    /// page without it.
    pub fn remove_field(&mut self, name: &str) -> Result<(), Error> {
        let mut mapping = self.to_mapping()?;
        if mapping.shift_remove(name).is_none() {
            return Ok(());
        }
        *self = Self::from_mapping(mapping)?;
        Ok(())
    }

    /// Build the frontmatter mapping: declared fields in the recorded order,
    /// then every field the order does not cover.
    pub(super) fn to_mapping(&self) -> Result<Mapping, Error> {
        let fields = self.present_fields()?;
        let mut mapping = Mapping::new();
        for name in &self.field_order {
            if let Some(value) = fields.get(name.as_str()) {
                mapping.insert(Value::from(name.as_str()), value.clone());
            }
        }
        for (key, value) in &fields {
            if !mapping.contains_key(key) {
                mapping.insert(key.clone(), value.clone());
            }
        }
        Ok(mapping)
    }

    /// Build the value of every present field: known fields in schema
    /// declaration order, then extension fields sorted by name.
    fn present_fields(&self) -> Result<Mapping, Error> {
        let mut mapping = Mapping::new();
        insert_string(&mut mapping, "title", &self.title);
        insert_string(&mut mapping, "type", &self.page_type);
        if let Some(text) = &self.description {
            insert_string(&mut mapping, "description", text);
        }
        insert_string(&mut mapping, "timestamp", &self.timestamp);
        if let Some(text) = &self.resource {
            insert_string(&mut mapping, "resource", text);
        }
        if let Some(sources) = &self.sources {
            mapping.insert(Value::from("sources"), string_sequence(sources));
        }
        mapping.insert(Value::from("tags"), string_sequence(&self.tags));
        if let Some(relations) = &self.supersedes {
            insert_values(
                &mut mapping,
                "supersedes",
                relations,
                Relation::to_value,
            );
        }
        if let Some(relations) = &self.superseded_by {
            insert_values(
                &mut mapping,
                "superseded_by",
                relations,
                Relation::to_value,
            );
        }
        if let Some(records) = &self.contradictions {
            insert_values(
                &mut mapping,
                "contradictions",
                records,
                Contradiction::to_value,
            );
        }
        for (name, value) in &self.extensions {
            if mapping.contains_key(name.as_str()) {
                return Err(Error::ReservedExtensionKey { key: name.clone() });
            }
            let yaml: &Value = value;
            mapping.insert(Value::from(name.as_str()), yaml.clone());
        }
        Ok(mapping)
    }
}

/// Collect the fields left in `mapping` after the known fields were read.
///
/// [`declared_order`] rejected a key that is not a string, so every key here
/// is a field name.
fn extension_fields(mapping: Mapping) -> BTreeMap<String, ExtensionValue> {
    mapping
        .into_iter()
        .filter_map(|(key, value)| match key {
            Value::String(name) => Some((name, ExtensionValue::from(value))),
            _ => None,
        })
        .collect()
}

/// Read the field names of `mapping` in the order the page declares them.
fn declared_order(mapping: &Mapping) -> Result<Vec<String>, Error> {
    mapping
        .keys()
        .map(|key| match key {
            Value::String(name) => Ok(name.clone()),
            _ => Err(unexpected("frontmatter key", "string")),
        })
        .collect()
}

/// Build the error for a value of the wrong type.
fn unexpected(field: &str, expected: &'static str) -> Error {
    Error::UnexpectedType { field: field.to_string(), expected }
}

/// Remove `key` from `mapping`.
fn take(mapping: &mut Mapping, key: &str) -> Option<Value> {
    mapping.remove(key)
}

/// Read a required string field.
fn required_string(mapping: &mut Mapping, key: &str) -> Result<String, Error> {
    required_string_at(mapping, key, key)
}

/// Read a required string field stored under `key`, reported as `field`.
fn required_string_at(
    mapping: &mut Mapping,
    key: &str,
    field: &str,
) -> Result<String, Error> {
    match take(mapping, key) {
        None | Some(Value::Null) => {
            Err(Error::MissingField { field: field.to_string() })
        }
        Some(value) => string_value(value, field),
    }
}

/// Read an optional string field.
fn optional_string(
    mapping: &mut Mapping,
    key: &str,
) -> Result<Option<String>, Error> {
    match take(mapping, key) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => string_value(value, key).map(Some),
    }
}

/// Read a required list of strings.
fn required_string_list(
    mapping: &mut Mapping,
    key: &str,
) -> Result<Vec<String>, Error> {
    required_string_list_at(mapping, key, key)
}

/// Read a required list of strings stored under `key`, reported as `field`.
fn required_string_list_at(
    mapping: &mut Mapping,
    key: &str,
    field: &str,
) -> Result<Vec<String>, Error> {
    match take(mapping, key) {
        None | Some(Value::Null) => {
            Err(Error::MissingField { field: field.to_string() })
        }
        Some(value) => string_list_value(value, field),
    }
}

/// Read an optional list of strings.
fn optional_string_list(
    mapping: &mut Mapping,
    key: &str,
) -> Result<Option<Vec<String>>, Error> {
    match take(mapping, key) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => string_list_value(value, key).map(Some),
    }
}

/// Read an optional sequence of nested objects.
fn optional_objects<T>(
    mapping: &mut Mapping,
    key: &str,
    decode: fn(Mapping, &str) -> Result<T, Error>,
) -> Result<Option<Vec<T>>, Error> {
    let Some(value) = take(mapping, key) else {
        return Ok(None);
    };
    if value.is_null() {
        return Ok(None);
    }
    let Value::Sequence(items) = value else {
        return Err(unexpected(key, "sequence of mappings"));
    };
    let mut decoded = Vec::with_capacity(items.len());
    for (index, item) in items.into_iter().enumerate() {
        let field = format!("{key}[{index}]");
        let Value::Mapping(entry) = item else {
            return Err(unexpected(&field, "mapping"));
        };
        decoded.push(decode(entry, &field)?);
    }
    Ok(Some(decoded))
}

/// Read a string value.
fn string_value(value: Value, field: &str) -> Result<String, Error> {
    match value {
        Value::String(text) => Ok(text),
        _ => Err(unexpected(field, "string")),
    }
}

/// Read a sequence of string values.
fn string_list_value(value: Value, field: &str) -> Result<Vec<String>, Error> {
    let Value::Sequence(items) = value else {
        return Err(unexpected(field, "sequence of strings"));
    };
    items
        .into_iter()
        .enumerate()
        .map(|(index, item)| string_value(item, &format!("{field}[{index}]")))
        .collect()
}

/// Report the first field of `mapping` that the schema does not declare.
fn reject_extra_fields(mapping: &Mapping, field: &str) -> Result<(), Error> {
    mapping.keys().next().map_or(Ok(()), |key| {
        let child = match key {
            Value::String(name) => name.clone(),
            other => format!("{other:?}"),
        };
        Err(Error::UnexpectedField { field: join(field, &child) })
    })
}

/// Join a parent field path with a child name.
fn join(field: &str, child: &str) -> String {
    format!("{field}.{child}")
}

/// Insert a string field.
fn insert_string(mapping: &mut Mapping, name: &str, text: &str) {
    mapping.insert(Value::from(name), Value::from(text));
}

/// Insert a sequence built from `items`.
fn insert_values<T>(
    mapping: &mut Mapping,
    name: &str,
    items: &[T],
    encode: fn(&T) -> Value,
) {
    let values = items.iter().map(encode).collect();
    mapping.insert(Value::from(name), Value::Sequence(values));
}

/// Build a YAML sequence of strings.
fn string_sequence(items: &[String]) -> Value {
    Value::Sequence(
        items.iter().map(|item| Value::from(item.as_str())).collect(),
    )
}
