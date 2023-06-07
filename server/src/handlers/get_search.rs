use ::protobuf::Message;
use ::serde_json::json;
use opensearch::SearchParts;
use protobuf::MessageField;

use crate::{model::known_message_types, protocol::Events};

#[derive(::serde::Deserialize)]
pub(crate) struct Query {
    search: String,
}

pub(crate) async fn handler(
    state: ::std::sync::Arc<crate::State>,
    query: Query,
) -> Result<Box<dyn ::warp::Reply>, ::warp::Rejection> {
    let response = crate::warp_try_err_500!(
        state
            .search
            .search(SearchParts::Index(&[
                "messages",
                "profile_names",
                "profile_descriptions",
            ]))
            .from(0)
            .size(10)
            .body(json!({
                "query": {
                    "match": {
                        "message_content": {
                            "query": query.search,
                            "fuzziness": 2
                        }
                    }
                }
            }))
            .send()
            .await
    );

    let response_body = crate::warp_try_err_500!(
        response.json::<crate::OpenSearchSearchL0>().await
    );

    let mut transaction = crate::warp_try_err_500!(state.pool.begin().await);

    let mut result_events: Events = Events::new();

    for hit in response_body.hits.hits {
        let id = hit._id;
        if hit._index == "messages" {
            let pointer = crate::warp_try_err_500!(
                crate::model::pointer::from_base64(&id)
            );

            let event_result = crate::warp_try_err_500!(
                crate::postgres::load_event(
                    &mut transaction,
                    pointer.system(),
                    pointer.process(),
                    *pointer.logical_clock()
                )
                .await
            );

            if let Some(event_result) = event_result {
                result_events
                    .events
                    .push(crate::model::signed_event::to_proto(&event_result));
            };
        } else {
            let system = crate::warp_try_err_500!(
                crate::model::public_key::from_base64(&id)
            );

            let content_type = if hit._index == "profile_names" {
                known_message_types::USERNAME
            } else {
                known_message_types::DESCRIPTION
            };

            let event_list_result =
                &crate::postgres::load_latest_system_wide_lww_event_by_type(
                    &mut transaction,
                    &system,
                    content_type,
                    1,
                )
                .await;

            let event_list = crate::warp_try_err_500!(event_list_result);

            if event_list.len() > 0 {
                result_events
                    .events
                    .push(crate::model::signed_event::to_proto(&event_list[0]));
            }
        }
    }

    let mut result =
        crate::protocol::ResultEventsAndRelatedEventsAndCursor::new();

    /*
    let mut processed_events =
        crate::process_mutations2(&mut transaction, history)
            .await
            .map_err(|e| crate::RequestError::Anyhow(e))?;

    result
        .related_events
        .append(&mut processed_events.related_events);
    */

    result.result_events = MessageField::some(result_events);

    crate::warp_try_err_500!(transaction.commit().await);

    let result_serialized = crate::warp_try_err_500!(result.write_to_bytes());

    Ok(Box::new(::warp::reply::with_status(
        result_serialized,
        ::warp::http::StatusCode::OK,
    )))
}
