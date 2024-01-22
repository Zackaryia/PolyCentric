use ::warp::Reply;

pub(crate) async fn handler() -> ::warp::reply::Response {
    todo!(); // Was causing errors while trying to dev

    // ::warp::reply::json(&::serde_json::json!({
    //     "sha": crate::version::VERSION,
    // }))
    // .into_response()
}
